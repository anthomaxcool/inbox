import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { countEvents, seedKey, seedThread } from '../helpers';

// Task 0.17: the agent-side attacks from the Phase 0 red-team (NEX-41 `redteam` log), replayed
// with an ordinary support key. See test/redteam.md for the map from log entry to test.

const BASE = 'https://agents.example.com';

function call(method: string, path: string, key: string | null, body?: unknown) {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (key) headers.Authorization = `Bearer ${key}`;
	return SELF.fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function draftRows(threadId: string) {
	const row = await env.DB.prepare(
		'SELECT (SELECT COUNT(*) FROM drafts WHERE thread_id = ?1) AS drafts, (SELECT COUNT(*) FROM draft_revisions r JOIN drafts d ON d.id = r.draft_id WHERE d.thread_id = ?1) AS revisions'
	)
		.bind(threadId)
		.first<{ drafts: number; revisions: number }>();
	return row!;
}

describe('red-team SD7: an agent cannot set recipients or headers', () => {
	const attempts: [string, Record<string, unknown>][] = [
		['to', { to: 'target@example.net' }],
		['cc', { cc: 'target@example.net' }],
		['bcc', { bcc: 'target@example.net' }],
		['reply_to', { reply_to: 'target@example.net' }],
		['headers.Bcc', { headers: { Bcc: 'target@example.net' } }],
		['from', { from: 'ceo@example.com' }]
	];

	for (const [name, extra] of attempts) {
		it(`refuses a draft carrying ${name} with 400, logs it, and writes nothing`, async () => {
			const { threadId } = await seedThread();
			const { key } = await seedKey();
			const before = await countEvents('draft.refused');
			const res = await call('PUT', `/v1/threads/${threadId}/draft`, key, { body: 'Hello', ...extra });
			expect(res.status).toBe(400);
			expect(await countEvents('draft.refused')).toBe(before + 1);
			expect(await draftRows(threadId)).toEqual({ drafts: 0, revisions: 0 });
		});
	}
});

describe('red-team §8.1 / §8.6: the agent host has no way to send', () => {
	it('404s every send-shaped route Atlas tried, with a valid key', async () => {
		const { threadId } = await seedThread();
		const { key } = await seedKey();
		expect((await call('GET', '/v1/send', key)).status).toBe(404);
		expect((await call('POST', '/v1/send', key, { body: 'x' })).status).toBe(404);
		expect((await call('POST', '/api/drafts/x/send', key, {})).status).toBe(404);
		expect((await call('POST', `/v1/threads/${threadId}/send`, key, {})).status).toBe(404);
	});

	it('405s a DELETE on a thread and 401s a missing or wrong key', async () => {
		const { threadId } = await seedThread();
		const { key } = await seedKey();
		expect((await call('DELETE', `/v1/threads/${threadId}`, key)).status).toBe(405);
		expect((await call('GET', '/v1/threads', null)).status).toBe(401);
		expect((await call('GET', '/v1/threads', 'ibx_notarealkeynotarealkeynotareal')).status).toBe(401);
	});

	it('refuses the input-handling probes: empty object, non-JSON, unknown thread', async () => {
		const { threadId } = await seedThread();
		const { key } = await seedKey();
		expect((await call('PUT', `/v1/threads/${threadId}/draft`, key, {})).status).toBe(400);
		const raw = await SELF.fetch(`${BASE}/v1/threads/${threadId}/draft`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
			body: 'not json'
		});
		expect(raw.status).toBe(400);
		expect((await call('PUT', '/v1/threads/zzzzzzzzzzzzzzzzzzzzzzzzzz/draft', key, { body: 'x' })).status).toBe(404);
	});
});

describe('red-team SD6: an agent cannot swap a draft under the owner', () => {
	it('409s an agent write while the draft is sending, 423s it once the owner edited, and never moves the revision', async () => {
		const { threadId } = await seedThread();
		const { key } = await seedKey();
		const first = await (await call('PUT', `/v1/threads/${threadId}/draft`, key, { body: 'v1' })).json<{ draftId: string; revisionId: string }>();

		await env.DB.prepare("UPDATE drafts SET status = 'sending' WHERE id = ?").bind(first.draftId).run();
		expect((await call('PUT', `/v1/threads/${threadId}/draft`, key, { body: 'swapped' })).status).toBe(409);

		await env.DB.prepare("UPDATE drafts SET status = 'open', owner_locked = 1 WHERE id = ?").bind(first.draftId).run();
		expect((await call('PUT', `/v1/threads/${threadId}/draft`, key, { body: 'swapped' })).status).toBe(423);

		const draft = await env.DB.prepare('SELECT current_revision_id AS r FROM drafts WHERE id = ?').bind(first.draftId).first<{ r: string }>();
		expect(draft!.r).toBe(first.revisionId);
		expect((await draftRows(threadId)).revisions).toBe(1);
	});
});
