import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { handleEmail, storeMessage, type InboundMessage } from '../../src/mail/ingest';

// Task 0.7: forward first, store raw + attachments, HTML → text, thread by In-Reply-To then References.

let seq = 0;
function eml(opts: {
	messageId?: string | null;
	inReplyTo?: string;
	references?: string;
	subject?: string;
	from?: string;
	replyTo?: string;
	body?: string;
	html?: string;
	attachment?: { name: string; base64: string };
}): Uint8Array {
	const id = opts.messageId === undefined ? `<m${++seq}.${Date.now()}@mail.example.org>` : opts.messageId;
	const headers = [
		`From: ${opts.from ?? 'Customer <customer@example.org>'}`,
		`To: ${env.MAILBOX}`,
		`Subject: ${opts.subject ?? 'Question about my plan'}`,
		'Date: Tue, 20 Oct 2026 10:00:00 -0400',
		'MIME-Version: 1.0'
	];
	if (id) headers.push(`Message-ID: ${id}`);
	if (opts.inReplyTo) headers.push(`In-Reply-To: ${opts.inReplyTo}`);
	if (opts.references) headers.push(`References: ${opts.references}`);
	if (opts.replyTo) headers.push(`Reply-To: ${opts.replyTo}`);
	let body: string;
	if (opts.attachment) {
		headers.push('Content-Type: multipart/mixed; boundary="b1"');
		body = [
			'--b1',
			'Content-Type: text/plain; charset=utf-8',
			'',
			opts.body ?? 'See attached.',
			'--b1',
			`Content-Type: application/pdf; name="${opts.attachment.name}"`,
			`Content-Disposition: attachment; filename="${opts.attachment.name}"`,
			'Content-Transfer-Encoding: base64',
			'',
			opts.attachment.base64,
			'--b1--',
			''
		].join('\r\n');
	} else if (opts.html) {
		headers.push('Content-Type: text/html; charset=utf-8');
		body = opts.html;
	} else {
		headers.push('Content-Type: text/plain; charset=utf-8');
		body = opts.body ?? 'Hello, I have a question.';
	}
	return new TextEncoder().encode(`${headers.join('\r\n')}\r\n\r\n${body}`);
}

async function threadCount() {
	return (await env.DB.prepare('SELECT COUNT(*) AS n FROM threads').first<{ n: number }>())!.n;
}

describe('ingest and threading', () => {
	it('starts a new thread for a fresh message and stores the raw .eml in R2', async () => {
		const r = await storeMessage(env, eml({ messageId: '<first@mail.example.org>' }));
		expect(r).toMatchObject({ stored: true, newThread: true });
		if (!r.stored) throw new Error();
		const msg = await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(r.messageId).first<Record<string, unknown>>();
		expect(msg).toMatchObject({ message_id_hdr: 'first@mail.example.org', direction: 'in', had_html: 0, from_address: 'customer@example.org' });
		expect(msg!.text_body).toContain('Hello, I have a question.');
		const raw = await env.R2.get(msg!.raw_key as string);
		expect(await raw!.text()).toContain('Message-ID: <first@mail.example.org>');
		const thread = await env.DB.prepare('SELECT * FROM threads WHERE id = ?').bind(r.threadId).first<Record<string, unknown>>();
		expect(thread).toMatchObject({ reply_to: 'customer@example.org', last_direction: 'in', subject: 'Question about my plan' });
	});

	it('threads a reply matched by In-Reply-To', async () => {
		const a = await storeMessage(env, eml({ messageId: '<irt-root@mail.example.org>' }));
		const b = await storeMessage(env, eml({ inReplyTo: '<irt-root@mail.example.org>', subject: 'Re: Question about my plan' }));
		if (!a.stored || !b.stored) throw new Error();
		expect(b.newThread).toBe(false);
		expect(b.threadId).toBe(a.threadId);
	});

	it('threads a reply matched only by References', async () => {
		const a = await storeMessage(env, eml({ messageId: '<ref-root@mail.example.org>' }));
		const b = await storeMessage(
			env,
			eml({ references: '<unknown-1@elsewhere.example> <ref-root@mail.example.org> <unknown-2@elsewhere.example>', subject: 'Something else' })
		);
		if (!a.stored || !b.stored) throw new Error();
		expect(b.threadId).toBe(a.threadId);
	});

	it('never threads on subject: same subject, no headers → new thread', async () => {
		const a = await storeMessage(env, eml({ subject: 'Refund please' }));
		const before = await threadCount();
		const b = await storeMessage(env, eml({ subject: 'Refund please' }));
		if (!a.stored || !b.stored) throw new Error();
		expect(b.newThread).toBe(true);
		expect(b.threadId).not.toBe(a.threadId);
		expect(await threadCount()).toBe(before + 1);
	});

	it('converts an HTML-only message to text and sets had_html', async () => {
		const r = await storeMessage(
			env,
			eml({
				html: '<html><head><style>p{color:red}</style><script>alert(1)</script></head><body><h1>Big&nbsp;sale</h1><p>Visit <a href="https://shop.example.com/x">our shop</a> &amp; save.</p><img src="https://t.example.com/p.gif"></body></html>'
			})
		);
		if (!r.stored) throw new Error();
		const msg = await env.DB.prepare('SELECT text_body, had_html FROM messages WHERE id = ?').bind(r.messageId).first<{ text_body: string; had_html: number }>();
		expect(msg!.had_html).toBe(1);
		expect(msg!.text_body).toContain('Big sale');
		expect(msg!.text_body).toContain('our shop (https://shop.example.com/x) & save.');
		expect(msg!.text_body).not.toMatch(/<|alert|color:red/);
	});

	it('un-archives a thread when a new message arrives', async () => {
		const a = await storeMessage(env, eml({ messageId: '<arch-root@mail.example.org>' }));
		if (!a.stored) throw new Error();
		await env.DB.prepare("UPDATE threads SET archived_at = '2026-10-20T00:00:00Z' WHERE id = ?").bind(a.threadId).run();
		const b = await storeMessage(env, eml({ inReplyTo: '<arch-root@mail.example.org>' }));
		if (!b.stored) throw new Error();
		const t = await env.DB.prepare('SELECT archived_at FROM threads WHERE id = ?').bind(a.threadId).first<{ archived_at: string | null }>();
		expect(t!.archived_at).toBeNull();
	});

	it('uses Reply-To of the latest inbound as the reply address', async () => {
		const r = await storeMessage(env, eml({ replyTo: 'Billing <billing@example.org>' }));
		if (!r.stored) throw new Error();
		const t = await env.DB.prepare('SELECT reply_to FROM threads WHERE id = ?').bind(r.threadId).first<{ reply_to: string }>();
		expect(t!.reply_to).toBe('billing@example.org');
	});

	it('stores attachments in R2 and ignores a duplicate Message-ID', async () => {
		const raw = eml({ messageId: '<att@mail.example.org>', attachment: { name: 'invoice.pdf', base64: btoa('%PDF-1.4 fake') } });
		const r = await storeMessage(env, raw);
		if (!r.stored) throw new Error();
		const att = await env.DB.prepare('SELECT * FROM attachments WHERE message_id = ?').bind(r.messageId).first<Record<string, unknown>>();
		expect(att).toMatchObject({ filename: 'invoice.pdf', content_type: 'application/pdf', size: 13 });
		expect(await (await env.R2.get(att!.r2_key as string))!.text()).toBe('%PDF-1.4 fake');
		expect(await storeMessage(env, raw)).toEqual({ stored: false, reason: 'duplicate' });
	});

	it('forwards before parsing, even when the message cannot be parsed', async () => {
		const calls: string[] = [];
		const message: InboundMessage = {
			from: 'customer@example.org',
			to: env.MAILBOX,
			rawSize: 10,
			raw: new ReadableStream(
				{
					pull() {
						calls.push('read');
						throw new Error('boom');
					}
				},
				{ highWaterMark: 0 }
			),
			forward: async (to) => {
				calls.push(`forward:${to}`);
			}
		};
		await expect(handleEmail(message, env)).rejects.toThrow();
		expect(calls[0]).toBe(`forward:${env.FORWARD_TO}`);
	});

	it('forwards but does not store mail for another address', async () => {
		let forwarded = false;
		const raw = eml({});
		const message: InboundMessage = {
			from: 'customer@example.org',
			to: 'someone-else@example.com',
			rawSize: raw.byteLength,
			raw: new Response(raw).body!,
			forward: async () => {
				forwarded = true;
			}
		};
		expect(await handleEmail(message, env)).toEqual({ stored: false, reason: 'wrong_mailbox' });
		expect(forwarded).toBe(true);
	});
});
