import { env } from 'cloudflare:workers';
import { nowIso, randomId, sha256Hex } from '../src/shared/ids';

export const db = () => env.DB;

export async function seedThread(opts: { mailbox?: string; subject?: string; replyTo?: string; messageIdHdr?: string } = {}) {
	const threadId = randomId();
	const messageId = randomId();
	const now = nowIso();
	const mailbox = opts.mailbox ?? env.MAILBOX;
	const replyTo = opts.replyTo ?? 'customer@example.org';
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO threads (id, mailbox, subject, counterparty_name, counterparty_address, reply_to, cc_seen, last_message_at, last_direction, created_at)
			 VALUES (?, ?, ?, 'Customer', ?, ?, '[]', ?, 'in', ?)`
		).bind(threadId, mailbox, opts.subject ?? 'Question about my plan', replyTo, replyTo, now, now),
		env.DB.prepare(
			`INSERT INTO messages (id, thread_id, mailbox, direction, message_id_hdr, references_hdr, from_name, from_address, "to", cc, subject, date, text_body, created_at)
			 VALUES (?, ?, ?, 'in', ?, ?, 'Customer', ?, ?, '[]', ?, ?, 'Hello', ?)`
		).bind(
			messageId,
			threadId,
			mailbox,
			opts.messageIdHdr ?? `${randomId()}@mail.example.org`,
			'<root-1@mail.example.org>',
			replyTo,
			JSON.stringify([mailbox]),
			opts.subject ?? 'Question about my plan',
			now,
			now
		)
	]);
	return { threadId, messageId };
}

export async function seedKey(label = `agent-${randomId().slice(0, 6)}`) {
	const id = randomId();
	const key = `ibx_${randomId()}${randomId()}`;
	await env.DB.prepare('INSERT INTO agent_keys (id, label, key_hash, created_at) VALUES (?, ?, ?, ?)')
		.bind(id, label, await sha256Hex(key), nowIso())
		.run();
	return { id, label, key };
}

export async function revokeKey(id: string) {
	await env.DB.prepare('UPDATE agent_keys SET revoked_at = ? WHERE id = ?').bind(nowIso(), id).run();
}

export async function countEvents(kind?: string): Promise<number> {
	const row = kind
		? await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE kind = ?').bind(kind).first<{ n: number }>()
		: await env.DB.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>();
	return row?.n ?? 0;
}
