import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { sendDraft, type SendEnv } from '../../src/app/send';
import { writeAgentDraft } from '../../src/mail/drafts';
import { seedKey, seedThread } from '../helpers';

// Task 0.10: plan §8.3 (revision binding), §8.4 (idempotency), §8.5 (recipients and headers from the thread).

const sendEnv = (): SendEnv => ({ DB: env.DB, MAILBOX: env.MAILBOX, RESEND_API_KEY: 'test-key-not-real' });

interface Delivery {
	idempotencyKey: string;
	payload: { from: string; to: string[]; subject: string; text: string; headers: Record<string, string>; [k: string]: unknown };
}

/** A fake provider that honours Idempotency-Key the way Resend does: a repeat key never delivers twice. */
function fakeProvider(opts: { loseFirstResponse?: boolean; status?: number; errorName?: string } = {}) {
	const deliveries: Delivery[] = [];
	const seen = new Map<string, string>();
	let calls = 0;
	const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
		calls++;
		const headers = new Headers(init?.headers);
		const key = headers.get('Idempotency-Key')!;
		if (opts.status && opts.status >= 400) {
			return new Response(JSON.stringify({ name: opts.errorName ?? 'validation_error' }), { status: opts.status });
		}
		let id = seen.get(key);
		if (!id) {
			id = `re_${deliveries.length + 1}`;
			seen.set(key, id);
			deliveries.push({ idempotencyKey: key, payload: JSON.parse(String(init?.body)) });
			if (opts.loseFirstResponse && deliveries.length === 1) throw new DOMException('The operation timed out.', 'TimeoutError');
		}
		return Response.json({ id });
	}) as typeof fetch;
	return { fetchFn, deliveries, calls: () => calls };
}

async function threadWithDraft(body = 'Here is the answer.', opts: Parameters<typeof seedThread>[0] = {}) {
	const { threadId } = await seedThread(opts);
	const key = await seedKey();
	const r = await writeAgentDraft(env.DB, threadId, body, key);
	if (!r.ok) throw new Error('seed draft failed');
	return { threadId, key, draftId: r.draftId, revisionId: r.revisionId };
}

async function sentRows(threadId: string) {
	return (await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND direction = 'out'").bind(threadId).first<{ n: number }>())!.n;
}

describe('§8.3 revision binding', () => {
	it('100 concurrent agent-write + send runs never send a revision other than the one requested', async () => {
		let sent = 0;
		let refused = 0;
		for (let i = 0; i < 100; i++) {
			const { threadId, key, draftId, revisionId } = await threadWithDraft(`revision one #${i}`);
			const provider = fakeProvider();
			// Random start offsets so both orders happen: sometimes the send locks the draft first.
			const jitter = () => new Promise((r) => setTimeout(r, Math.random() * 3));
			const [, outcome] = await Promise.all([
				jitter().then(() => writeAgentDraft(env.DB, threadId, `revision two #${i}`, key)),
				jitter().then(() => sendDraft(sendEnv(), { draftId, revisionId, idempotencyKey: crypto.randomUUID() }, provider.fetchFn))
			]);
			for (const d of provider.deliveries) expect(d.payload.text).toBe(`revision one #${i}`);
			if (outcome.status === 200) {
				sent++;
				expect(provider.deliveries).toHaveLength(1);
			} else {
				refused++;
				expect(outcome).toEqual({ status: 409, body: { error: 'revision_changed' } });
				expect(provider.deliveries).toHaveLength(0);
			}
		}
		expect(sent + refused).toBe(100);
		expect(sent).toBeGreaterThan(0);
		expect(refused).toBeGreaterThan(0);
		// ~2 s locally, but shared CI runners are several times slower than the 5 s default allows.
	}, 30_000);

	it('refuses a stale revision with 409 and a closed draft with 410', async () => {
		const { threadId, key, draftId, revisionId } = await threadWithDraft();
		await writeAgentDraft(env.DB, threadId, 'newer', key);
		const provider = fakeProvider();
		expect(await sendDraft(sendEnv(), { draftId, revisionId, idempotencyKey: crypto.randomUUID() }, provider.fetchFn)).toEqual({
			status: 409,
			body: { error: 'revision_changed' }
		});
		await env.DB.prepare("UPDATE drafts SET status = 'discarded' WHERE id = ?").bind(draftId).run();
		const current = await env.DB.prepare('SELECT current_revision_id AS r FROM drafts WHERE id = ?').bind(draftId).first<{ r: string }>();
		expect(await sendDraft(sendEnv(), { draftId, revisionId: current!.r, idempotencyKey: crypto.randomUUID() }, provider.fetchFn)).toEqual({
			status: 410,
			body: { error: 'draft_closed' }
		});
		expect(provider.calls()).toBe(0);
	});

	it('refuses with 409 mailbox_mismatch when the thread belongs to another mailbox', async () => {
		const { draftId, revisionId } = await threadWithDraft('x', { mailbox: 'old-mailbox@example.com' });
		const provider = fakeProvider();
		expect(await sendDraft(sendEnv(), { draftId, revisionId, idempotencyKey: crypto.randomUUID() }, provider.fetchFn)).toEqual({
			status: 409,
			body: { error: 'mailbox_mismatch' }
		});
		expect(provider.calls()).toBe(0);
	});
});

describe('§8.4 idempotency', () => {
	it('a double tap with the same key calls the provider once and stores one sent message', async () => {
		const { threadId, draftId, revisionId } = await threadWithDraft();
		const provider = fakeProvider();
		const idempotencyKey = crypto.randomUUID();
		const [a, b] = await Promise.all([
			sendDraft(sendEnv(), { draftId, revisionId, idempotencyKey }, provider.fetchFn),
			sendDraft(sendEnv(), { draftId, revisionId, idempotencyKey }, provider.fetchFn)
		]);
		expect(provider.calls()).toBe(1);
		expect([a.status, b.status].sort()).toEqual([200, 202]);
		const again = await sendDraft(sendEnv(), { draftId, revisionId, idempotencyKey }, provider.fetchFn);
		expect(again).toMatchObject({ status: 200, body: { status: 'sent' } });
		expect(provider.calls()).toBe(1);
		expect(await sentRows(threadId)).toBe(1);
	});

	it('a double tap from two tabs (two keys) sends once', async () => {
		const { threadId, draftId, revisionId } = await threadWithDraft();
		const provider = fakeProvider();
		const results = await Promise.all([
			sendDraft(sendEnv(), { draftId, revisionId, idempotencyKey: crypto.randomUUID() }, provider.fetchFn),
			sendDraft(sendEnv(), { draftId, revisionId, idempotencyKey: crypto.randomUUID() }, provider.fetchFn)
		]);
		expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
		expect(provider.deliveries).toHaveLength(1);
		expect(await sentRows(threadId)).toBe(1);
	});

	it('retry after a timeout delivers exactly once and ends with one sent row', async () => {
		const { threadId, draftId, revisionId } = await threadWithDraft();
		const provider = fakeProvider({ loseFirstResponse: true });
		const idempotencyKey = crypto.randomUUID();
		const first = await sendDraft(sendEnv(), { draftId, revisionId, idempotencyKey }, provider.fetchFn);
		expect(first).toMatchObject({ status: 202, body: { status: 'unknown' } });
		expect(await sentRows(threadId)).toBe(0);
		// The draft stays locked while the outcome is unknown: no agent can swap the body.
		const draft = await env.DB.prepare('SELECT status FROM drafts WHERE id = ?').bind(draftId).first<{ status: string }>();
		expect(draft!.status).toBe('sending');

		const retry = await sendDraft(sendEnv(), { draftId, revisionId, idempotencyKey }, provider.fetchFn);
		expect(retry).toMatchObject({ status: 200, body: { status: 'sent' } });
		expect(provider.deliveries).toHaveLength(1);
		expect(provider.deliveries[0].idempotencyKey).toBe(idempotencyKey);
		expect(await sentRows(threadId)).toBe(1);
		const attempts = await env.DB.prepare("SELECT COUNT(*) AS n FROM send_attempts WHERE draft_id = ? AND status = 'sent'").bind(draftId).first<{ n: number }>();
		expect(attempts!.n).toBe(1);
	});

	it('a provider 4xx fails the attempt and reopens the draft', async () => {
		const { draftId, revisionId } = await threadWithDraft();
		const provider = fakeProvider({ status: 422 });
		const r = await sendDraft(sendEnv(), { draftId, revisionId, idempotencyKey: crypto.randomUUID() }, provider.fetchFn);
		expect(r).toMatchObject({ status: 200, body: { status: 'failed', error: 'provider_422:validation_error' } });
		const draft = await env.DB.prepare('SELECT status FROM drafts WHERE id = ?').bind(draftId).first<{ status: string }>();
		expect(draft!.status).toBe('open');
	});

	it('refuses a key reused for a different revision', async () => {
		const { threadId, draftId, revisionId } = await threadWithDraft();
		const idempotencyKey = crypto.randomUUID();
		await sendDraft(sendEnv(), { draftId, revisionId, idempotencyKey }, fakeProvider().fetchFn);
		const other = await threadWithDraft();
		expect(await sendDraft(sendEnv(), { draftId: other.draftId, revisionId: other.revisionId, idempotencyKey }, fakeProvider().fetchFn)).toEqual({
			status: 409,
			body: { error: 'idempotency_key_reused' }
		});
		expect(await sentRows(threadId)).toBe(1);
	});
});

describe('§8.5 recipients and headers come from the thread', () => {
	it('sends header-looking body lines as literal text, to exactly one recipient', async () => {
		const body = 'Thanks!\nBcc: x@y.example\r\nTo: attacker@example.net\r\n\r\nCc: also@example.net';
		const { draftId, revisionId } = await threadWithDraft(body, { subject: 'Re: RE: Billing', replyTo: 'customer@example.org' });
		const provider = fakeProvider();
		await sendDraft(sendEnv(), { draftId, revisionId, idempotencyKey: crypto.randomUUID() }, provider.fetchFn);
		expect(provider.deliveries).toHaveLength(1);
		const p = provider.deliveries[0].payload;
		expect(p.text).toBe(body);
		expect(p.to).toEqual(['customer@example.org']);
		expect(Object.keys(p).sort()).toEqual(['from', 'headers', 'subject', 'text', 'to']);
		expect(p.from).toBe(env.MAILBOX);
		expect(p.subject).toBe('Re: RE: Billing');
		expect(Object.keys(p.headers).sort()).toEqual(['In-Reply-To', 'Message-ID', 'References']);
	});

	it('sets Re: once, In-Reply-To, References and an explicit Message-ID on the mailbox domain', async () => {
		const { threadId, draftId, revisionId } = await threadWithDraft('Answer', { subject: 'Where is my order', messageIdHdr: 'cust-1@mail.example.org' });
		const provider = fakeProvider();
		const r = await sendDraft(sendEnv(), { draftId, revisionId, idempotencyKey: crypto.randomUUID() }, provider.fetchFn);
		if (r.status !== 200) throw new Error(JSON.stringify(r));
		const p = provider.deliveries[0].payload;
		expect(p.subject).toBe('Re: Where is my order');
		expect(p.headers['In-Reply-To']).toBe('<cust-1@mail.example.org>');
		expect(p.headers.References).toBe('<root-1@mail.example.org> <cust-1@mail.example.org>');
		expect(p.headers['Message-ID']).toBe(`<${r.body.sendAttemptId}@example.com>`);
		const out = await env.DB.prepare("SELECT message_id_hdr, text_body FROM messages WHERE thread_id = ? AND direction = 'out'").bind(threadId).first();
		expect(out).toEqual({ message_id_hdr: `${r.body.sendAttemptId}@example.com`, text_body: 'Answer' });
	});
});
