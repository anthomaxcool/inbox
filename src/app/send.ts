import { eventStatement, logEvent } from '../shared/events';
import { nowIso, randomId } from '../shared/ids';
import { domainOf, formatMessageIds, parseMessageIds, replySubject } from '../shared/msgid';

// THE ONLY MODULE THAT SENDS MAIL (plan §8.1). `pnpm check:send-surface` fails if any other file
// mentions the provider's host, its key, or a `send_email` binding.
//
// It sends exactly one revision of one draft, to the thread's reply address, after the owner's
// request passed ownerGuard. Recipients, subject and threading headers come from the thread,
// never from the draft (plan §8.5).

export interface SendEnv {
	DB: D1Database;
	MAILBOX: string;
	RESEND_API_KEY: string;
}

export interface SendRequest {
	draftId: string;
	revisionId: string;
	idempotencyKey: string;
}

export type SendOutcome =
	| { status: 200 | 202; body: { status: 'sent' | 'pending' | 'unknown' | 'failed'; sendAttemptId: string; error?: string } }
	| { status: 409 | 410 | 404; body: { error: string } };

const RESEND_URL = 'https://api.resend.com/emails';
const PROVIDER_TIMEOUT_MS = 10_000;
/** A `pending` attempt older than this is treated as `unknown` and retried with the same key. */
const STALE_PENDING_MS = 60_000;
const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;

interface Attempt {
	id: string;
	draft_id: string;
	revision_id: string;
	status: 'pending' | 'sent' | 'failed' | 'unknown';
	error: string | null;
	created_at: string;
}

function refuse(status: 409 | 410 | 404, error: string): SendOutcome {
	return { status, body: { error } };
}

function isUniqueViolation(err: unknown): boolean {
	return /UNIQUE constraint failed/i.test((err as Error)?.message ?? '');
}

async function findAttempt(db: D1Database, idempotencyKey: string): Promise<Attempt | null> {
	return db
		.prepare('SELECT id, draft_id, revision_id, status, error, created_at FROM send_attempts WHERE idempotency_key = ?')
		.bind(idempotencyKey)
		.first<Attempt>();
}

export async function sendDraft(env: SendEnv, req: SendRequest, fetchFn: typeof fetch = fetch): Promise<SendOutcome> {
	const db = env.DB;
	const mailbox = env.MAILBOX.toLowerCase();

	// A repeat key returns the first attempt's state, and never calls the provider again
	// unless that attempt's outcome is unknown (plan §8.4).
	const existing = await findAttempt(db, req.idempotencyKey);
	if (existing) return resume(env, existing, req, fetchFn);

	const draft = await db
		.prepare('SELECT d.id, d.status, d.current_revision_id, t.mailbox FROM drafts d JOIN threads t ON t.id = d.thread_id WHERE d.id = ?')
		.bind(req.draftId)
		.first<{ id: string; status: string; current_revision_id: string; mailbox: string }>();
	if (!draft) return refuse(404, 'not_found');
	if (draft.mailbox !== mailbox) {
		await logEvent(db, 'owner', 'send.refused', req.draftId, 'mailbox_mismatch');
		return refuse(409, 'mailbox_mismatch');
	}

	// Revision binding (plan §8.3): in one transaction, record the attempt and lock the draft,
	// only if it is open and its current revision is the one the owner saw.
	const attemptId = randomId();
	const now = nowIso();
	let changes = 0;
	try {
		const [insert] = await db.batch([
			db
				.prepare(
					`INSERT INTO send_attempts (id, draft_id, revision_id, idempotency_key, status, to_address, created_at)
					 SELECT ?, d.id, d.current_revision_id, ?, 'pending', t.reply_to, ?
					 FROM drafts d JOIN threads t ON t.id = d.thread_id
					 WHERE d.id = ? AND d.status = 'open' AND d.current_revision_id = ? AND t.mailbox = ?`
				)
				.bind(attemptId, req.idempotencyKey, now, req.draftId, req.revisionId, mailbox),
			db
				.prepare(
					`UPDATE drafts SET status = 'sending'
					 WHERE id = ? AND status = 'open' AND current_revision_id = ? AND EXISTS (SELECT 1 FROM send_attempts WHERE id = ?)`
				)
				.bind(req.draftId, req.revisionId, attemptId)
		]);
		changes = insert.meta.changes;
	} catch (err) {
		if (!isUniqueViolation(err)) throw err;
		const raced = await findAttempt(db, req.idempotencyKey);
		if (raced) return resume(env, raced, req, fetchFn);
		throw err;
	}

	if (changes !== 1) {
		// A concurrent request with the same key may have locked the draft first: report its attempt.
		const raced = await findAttempt(db, req.idempotencyKey);
		if (raced) return resume(env, raced, req, fetchFn);
		const now2 = await db.prepare('SELECT status FROM drafts WHERE id = ?').bind(req.draftId).first<{ status: string }>();
		const code = now2?.status === 'sent' || now2?.status === 'discarded' ? 410 : 409;
		const reason = code === 410 ? 'draft_closed' : 'revision_changed';
		await logEvent(db, 'owner', 'send.refused', req.draftId, reason);
		return refuse(code, reason);
	}

	return deliver(env, attemptId, fetchFn);
}

async function resume(env: SendEnv, attempt: Attempt, req: SendRequest, fetchFn: typeof fetch): Promise<SendOutcome> {
	if (attempt.draft_id !== req.draftId || attempt.revision_id !== req.revisionId) {
		await logEvent(env.DB, 'owner', 'send.refused', req.draftId, 'idempotency_key_reused');
		return refuse(409, 'idempotency_key_reused');
	}
	const stale = Date.now() - Date.parse(attempt.created_at) > STALE_PENDING_MS;
	if (attempt.status === 'unknown' || (attempt.status === 'pending' && stale)) return deliver(env, attempt.id, fetchFn);
	return {
		status: attempt.status === 'pending' ? 202 : 200,
		body: { status: attempt.status, sendAttemptId: attempt.id, ...(attempt.error ? { error: attempt.error } : {}) }
	};
}

interface Envelope {
	threadId: string;
	draftId: string;
	idempotencyKey: string;
	to: string;
	subject: string;
	body: string;
	inReplyTo: string | null;
	references: string[];
}

async function loadEnvelope(db: D1Database, attemptId: string): Promise<Envelope> {
	const row = await db
		.prepare(
			`SELECT a.idempotency_key, a.to_address, a.draft_id, r.body, t.id AS thread_id, t.subject
			 FROM send_attempts a
			 JOIN draft_revisions r ON r.id = a.revision_id
			 JOIN drafts d ON d.id = a.draft_id
			 JOIN threads t ON t.id = d.thread_id
			 WHERE a.id = ?`
		)
		.bind(attemptId)
		.first<{ idempotency_key: string; to_address: string; draft_id: string; body: string; thread_id: string; subject: string }>();
	if (!row) throw new Error('send attempt vanished');
	const latestInbound = await db
		.prepare(
			"SELECT message_id_hdr, references_hdr FROM messages WHERE thread_id = ? AND direction = 'in' ORDER BY date DESC, created_at DESC LIMIT 1"
		)
		.bind(row.thread_id)
		.first<{ message_id_hdr: string; references_hdr: string | null }>();
	const references = latestInbound
		? [...new Set([...parseMessageIds(latestInbound.references_hdr), latestInbound.message_id_hdr])].slice(-20)
		: [];
	return {
		threadId: row.thread_id,
		draftId: row.draft_id,
		idempotencyKey: row.idempotency_key,
		to: row.to_address,
		subject: replySubject(row.subject.replace(/[\r\n]+/g, ' ')),
		body: row.body,
		inReplyTo: latestInbound?.message_id_hdr ?? null,
		references
	};
}

async function deliver(env: SendEnv, attemptId: string, fetchFn: typeof fetch): Promise<SendOutcome> {
	const db = env.DB;
	const mailbox = env.MAILBOX.toLowerCase();
	const e = await loadEnvelope(db, attemptId);

	if (!ADDRESS.test(e.to)) return finishFailed(db, attemptId, e.draftId, 'bad_recipient');

	const messageIdHdr = `${attemptId}@${domainOf(mailbox)}`;
	const headers: Record<string, string> = { 'Message-ID': `<${messageIdHdr}>` };
	if (e.inReplyTo) headers['In-Reply-To'] = `<${e.inReplyTo}>`;
	if (e.references.length) headers.References = formatMessageIds(e.references);

	// Exactly these fields. No cc, bcc, reply_to or any other header (plan §8.5).
	const payload = { from: mailbox, to: [e.to], subject: e.subject, text: e.body, headers };

	let response: Response;
	try {
		response = await fetchFn(RESEND_URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${env.RESEND_API_KEY}`,
				'Content-Type': 'application/json',
				'Idempotency-Key': e.idempotencyKey
			},
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
		});
	} catch (err) {
		return finishUnknown(db, attemptId, `network:${(err as Error).name}`);
	}

	if (response.ok) {
		const data = (await response.json().catch(() => ({}))) as { id?: string };
		const now = nowIso();
		await db.batch([
			db
				.prepare("UPDATE send_attempts SET status = 'sent', provider_message_id = ?, error = NULL, finished_at = ? WHERE id = ?")
				.bind(data.id ?? null, now, attemptId),
			db.prepare("UPDATE drafts SET status = 'sent', closed_at = ? WHERE id = ?").bind(now, e.draftId),
			db
				.prepare(
					`INSERT INTO messages (id, thread_id, mailbox, direction, message_id_hdr, in_reply_to, references_hdr, from_name, from_address, "to", cc, subject, date, text_body, had_html, raw_key, size, send_attempt_id, created_at)
					 VALUES (?, ?, ?, 'out', ?, ?, ?, NULL, ?, ?, '[]', ?, ?, ?, 0, NULL, ?, ?, ?)`
				)
				.bind(
					randomId(),
					e.threadId,
					mailbox,
					messageIdHdr,
					e.inReplyTo,
					e.references.length ? formatMessageIds(e.references) : null,
					mailbox,
					JSON.stringify([e.to]),
					e.subject,
					now,
					e.body,
					new TextEncoder().encode(e.body).byteLength,
					attemptId,
					now
				),
			db.prepare("UPDATE threads SET last_message_at = ?, last_direction = 'out' WHERE id = ?").bind(now, e.threadId),
			eventStatement(db, 'owner', 'send.sent', e.draftId, attemptId)
		]);
		return { status: 200, body: { status: 'sent', sendAttemptId: attemptId } };
	}

	const detail = await response.text().catch(() => '');
	const code = providerErrorCode(response.status, detail);
	// 5xx, and Resend's 409 for a concurrent request with the same key, leave the outcome unknown:
	// retrying the same idempotency key resolves it without a second send.
	if (response.status >= 500 || response.status === 409) return finishUnknown(db, attemptId, code);
	return finishFailed(db, attemptId, e.draftId, code);
}

function providerErrorCode(status: number, detail: string): string {
	let name = '';
	try {
		name = String((JSON.parse(detail) as { name?: string }).name ?? '');
	} catch {
		/* not JSON */
	}
	if (status === 429) return name === 'daily_quota_exceeded' ? 'daily_quota_exceeded' : 'rate_limited';
	return `provider_${status}${name ? `:${name}` : ''}`.slice(0, 100);
}

async function finishUnknown(db: D1Database, attemptId: string, error: string): Promise<SendOutcome> {
	await db.batch([
		db.prepare("UPDATE send_attempts SET status = 'unknown', error = ? WHERE id = ? AND status IN ('pending', 'unknown')").bind(error, attemptId),
		eventStatement(db, 'owner', 'send.unknown', attemptId, error)
	]);
	return { status: 202, body: { status: 'unknown', sendAttemptId: attemptId, error } };
}

async function finishFailed(db: D1Database, attemptId: string, draftId: string, error: string): Promise<SendOutcome> {
	await db.batch([
		db.prepare("UPDATE send_attempts SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").bind(error, nowIso(), attemptId),
		// The draft goes back to open so the owner can retry with a fresh key.
		db.prepare("UPDATE drafts SET status = 'open' WHERE id = ? AND status = 'sending'").bind(draftId),
		eventStatement(db, 'owner', 'send.failed', attemptId, error)
	]);
	return { status: 200, body: { status: 'failed', sendAttemptId: attemptId, error } };
}
