import PostalMime, { type Email as ParsedEmail } from 'postal-mime';
import { logEvent } from '../shared/events';
import { nowIso, randomId } from '../shared/ids';
import { firstMessageId, formatMessageIds, parseMessageIds } from '../shared/msgid';
import type { MailEnv } from './env';
import { htmlToText } from './html-to-text';

/** What the email handler needs from Cloudflare's ForwardableEmailMessage. */
export interface InboundMessage {
	readonly from: string;
	readonly to: string;
	readonly raw: ReadableStream<Uint8Array>;
	readonly rawSize: number;
	forward(rcptTo: string, headers?: Headers): Promise<unknown>;
}

export type IngestResult =
	| { stored: true; threadId: string; messageId: string; newThread: boolean }
	| { stored: false; reason: 'wrong_mailbox' | 'duplicate' };

/**
 * Email Routing handler: forward first, then parse, store and thread.
 * The forward runs before anything that can exceed the CPU limit, so the safety copy always goes out.
 */
export async function handleEmail(message: InboundMessage, env: MailEnv): Promise<IngestResult> {
	if (env.FORWARD_TO) {
		try {
			await message.forward(env.FORWARD_TO);
		} catch (err) {
			console.error('forward failed', (err as Error).message);
			await logEvent(env.DB, 'system', 'mail.forward_failed', null, (err as Error).message.slice(0, 200));
		}
	}

	if (message.to.toLowerCase() !== env.MAILBOX.toLowerCase()) {
		await logEvent(env.DB, 'system', 'mail.wrong_mailbox');
		return { stored: false, reason: 'wrong_mailbox' };
	}

	const raw = await readRaw(message.raw, message.rawSize);
	return storeMessage(env, raw);
}

async function readRaw(stream: ReadableStream<Uint8Array>, size: number): Promise<Uint8Array> {
	const out = new Uint8Array(size);
	let offset = 0;
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (offset + value.length > size) {
			await reader.cancel();
			throw new Error('raw stream exceeds declared size');
		}
		out.set(value, offset);
		offset += value.length;
	}
	return offset === size ? out : out.subarray(0, offset);
}

function safeFilename(name: string | null | undefined): string {
	const cleaned = (name ?? '').replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').trim();
	return cleaned.slice(0, 200) || 'attachment';
}

function sizeOf(content: ArrayBuffer | Uint8Array | string): number {
	return typeof content === 'string' ? new TextEncoder().encode(content).byteLength : content.byteLength;
}

export async function storeMessage(env: MailEnv, raw: Uint8Array): Promise<IngestResult> {
	const db = env.DB;
	const mailbox = env.MAILBOX.toLowerCase();
	const email: ParsedEmail = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });

	const messageRowId = randomId();
	const now = nowIso();
	const messageIdHdr = firstMessageId(email.messageId) ?? `missing-${messageRowId}@inbox.invalid`;

	const dupe = await db
		.prepare('SELECT id FROM messages WHERE mailbox = ? AND message_id_hdr = ?')
		.bind(mailbox, messageIdHdr)
		.first();
	if (dupe) {
		await logEvent(db, 'system', 'mail.duplicate', null, null);
		return { stored: false, reason: 'duplicate' };
	}

	// Threading: In-Reply-To first, then References newest to oldest, within this mailbox only.
	// Never by subject (plan §7).
	const inReplyTo = firstMessageId(email.inReplyTo);
	const references = parseMessageIds(email.references);
	const candidates = [...new Set([...(inReplyTo ? [inReplyTo] : []), ...[...references].reverse()])].slice(0, 50);
	let threadId: string | null = null;
	if (candidates.length > 0) {
		const placeholders = candidates.map(() => '?').join(', ');
		const rows = await db
			.prepare(`SELECT message_id_hdr, thread_id FROM messages WHERE mailbox = ? AND message_id_hdr IN (${placeholders})`)
			.bind(mailbox, ...candidates)
			.all<{ message_id_hdr: string; thread_id: string }>();
		const byId = new Map(rows.results.map((r) => [r.message_id_hdr, r.thread_id]));
		for (const id of candidates) {
			const hit = byId.get(id);
			if (hit) {
				threadId = hit;
				break;
			}
		}
	}

	const fromAddress = (email.from?.address ?? '').toLowerCase();
	const fromName = email.from?.name || null;
	const replyTo = (email.replyTo?.[0]?.address ?? fromAddress).toLowerCase();
	const to = (email.to ?? []).map((a) => a.address?.toLowerCase()).filter(Boolean) as string[];
	const cc = (email.cc ?? []).map((a) => a.address?.toLowerCase()).filter(Boolean) as string[];
	const subject = email.subject ?? '';
	const date = email.date && !Number.isNaN(Date.parse(email.date)) ? new Date(email.date).toISOString() : now;
	const hadHtml = email.html ? 1 : 0;
	const textBody = email.text?.trim() ? email.text : email.html ? htmlToText(email.html) : '';

	const rawKey = `raw/${messageRowId}.eml`;
	await env.R2.put(rawKey, raw, { httpMetadata: { contentType: 'message/rfc822' } });

	const attachmentRows: { id: string; filename: string; contentType: string; size: number; key: string }[] = [];
	for (const att of email.attachments ?? []) {
		const id = randomId();
		const key = `att/${messageRowId}/${id}`;
		await env.R2.put(key, att.content);
		attachmentRows.push({
			id,
			filename: safeFilename(att.filename),
			contentType: (att.mimeType || 'application/octet-stream').slice(0, 100),
			size: sizeOf(att.content),
			key
		});
	}

	const statements: D1PreparedStatement[] = [];
	const newThread = threadId === null;
	if (threadId === null) {
		threadId = randomId();
		statements.push(
			db
				.prepare(
					`INSERT INTO threads (id, mailbox, subject, counterparty_name, counterparty_address, reply_to, cc_seen, last_message_at, last_direction, archived_at, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in', NULL, ?)`
				)
				.bind(threadId, mailbox, subject, fromName, fromAddress, replyTo, JSON.stringify(cc), date, now)
		);
	} else {
		// Latest inbound wins for reply_to and counterparty. A new inbound un-archives the thread.
		statements.push(
			db
				.prepare(
					`UPDATE threads SET counterparty_name = ?, counterparty_address = ?, reply_to = ?,
					 cc_seen = (SELECT json_group_array(value) FROM (SELECT value FROM json_each(threads.cc_seen) UNION SELECT value FROM json_each(?))),
					 last_message_at = MAX(last_message_at, ?), last_direction = 'in', archived_at = NULL
					 WHERE id = ?`
				)
				.bind(fromName, fromAddress, replyTo, JSON.stringify(cc), date, threadId)
		);
	}
	statements.push(
		db
			.prepare(
				`INSERT INTO messages (id, thread_id, mailbox, direction, message_id_hdr, in_reply_to, references_hdr, from_name, from_address, "to", cc, subject, date, text_body, had_html, raw_key, size, send_attempt_id, created_at)
				 VALUES (?, ?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
			)
			.bind(
				messageRowId,
				threadId,
				mailbox,
				messageIdHdr,
				inReplyTo,
				references.length ? formatMessageIds(references) : null,
				fromName,
				fromAddress,
				JSON.stringify(to),
				JSON.stringify(cc),
				subject,
				date,
				textBody,
				hadHtml,
				rawKey,
				raw.byteLength,
				now
			)
	);
	for (const a of attachmentRows) {
		statements.push(
			db
				.prepare('INSERT INTO attachments (id, message_id, filename, content_type, size, r2_key) VALUES (?, ?, ?, ?, ?, ?)')
				.bind(a.id, messageRowId, a.filename, a.contentType, a.size, a.key)
		);
	}
	await db.batch(statements);
	return { stored: true, threadId, messageId: messageRowId, newThread };
}
