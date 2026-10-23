import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { nowIso, randomId } from '../../src/shared/ids';
import { seedThread } from '../helpers';

// Migration 0001: each unique index rejects a duplicate insert (task 0.6).
describe('migration 0001 unique indexes', () => {
	const now = nowIso();

	it('rejects a second message with the same Message-ID in the same mailbox, allows it in another', async () => {
		const { threadId } = await seedThread({ messageIdHdr: 'same@example.org' });
		const insert = (mailbox: string) =>
			env.DB.prepare(
				`INSERT INTO messages (id, thread_id, mailbox, direction, message_id_hdr, from_address, subject, date, created_at)
				 VALUES (?, ?, ?, 'in', 'same@example.org', 'a@example.org', 's', ?, ?)`
			)
				.bind(randomId(), threadId, mailbox, now, now)
				.run();
		await expect(insert(env.MAILBOX)).rejects.toThrow(/UNIQUE/);
		await expect(insert('other@example.com')).resolves.toBeTruthy();
	});

	it('allows one open or sending draft per thread, any number of closed ones', async () => {
		const { threadId } = await seedThread();
		const insert = (status: string) =>
			env.DB.prepare('INSERT INTO drafts (id, thread_id, status, created_at) VALUES (?, ?, ?, ?)')
				.bind(randomId(), threadId, status, now)
				.run();
		await insert('sent');
		await insert('discarded');
		await insert('discarded');
		await insert('open');
		await expect(insert('open')).rejects.toThrow(/UNIQUE/);
		await expect(insert('sending')).rejects.toThrow(/UNIQUE/);
	});

	it('rejects a duplicate (draft_id, n) revision', async () => {
		const { threadId } = await seedThread();
		const draftId = randomId();
		await env.DB.prepare("INSERT INTO drafts (id, thread_id, status, created_at) VALUES (?, ?, 'open', ?)").bind(draftId, threadId, now).run();
		const insert = () =>
			env.DB.prepare(
				"INSERT INTO draft_revisions (id, draft_id, n, body, body_sha256, author, created_at) VALUES (?, ?, 1, 'b', 'h', 'owner', ?)"
			)
				.bind(randomId(), draftId, now)
				.run();
		await insert();
		await expect(insert()).rejects.toThrow(/UNIQUE/);
	});

	it('rejects a reused idempotency key', async () => {
		const { threadId } = await seedThread();
		const draftId = randomId();
		const revisionId = randomId();
		await env.DB.batch([
			env.DB.prepare("INSERT INTO drafts (id, thread_id, status, created_at) VALUES (?, ?, 'open', ?)").bind(draftId, threadId, now),
			env.DB.prepare(
				"INSERT INTO draft_revisions (id, draft_id, n, body, body_sha256, author, created_at) VALUES (?, ?, 1, 'b', 'h', 'owner', ?)"
			).bind(revisionId, draftId, now)
		]);
		const insert = () =>
			env.DB.prepare(
				"INSERT INTO send_attempts (id, draft_id, revision_id, idempotency_key, status, to_address, created_at) VALUES (?, ?, ?, 'key-1', 'pending', 'c@example.org', ?)"
			)
				.bind(randomId(), draftId, revisionId, now)
				.run();
		await insert();
		await expect(insert()).rejects.toThrow(/UNIQUE/);
	});

	it('rejects a duplicate agent key label and hash', async () => {
		const insert = (label: string, hash: string) =>
			env.DB.prepare('INSERT INTO agent_keys (id, label, key_hash, created_at) VALUES (?, ?, ?, ?)').bind(randomId(), label, hash, now).run();
		await insert('support-agent', 'h1');
		await expect(insert('support-agent', 'h2')).rejects.toThrow(/UNIQUE/);
		await expect(insert('other', 'h1')).rejects.toThrow(/UNIQUE/);
	});

	it('generates 26-char base32 IDs that do not repeat', () => {
		const ids = new Set(Array.from({ length: 1000 }, randomId));
		expect(ids.size).toBe(1000);
		for (const id of ids) expect(id).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
	});
});
