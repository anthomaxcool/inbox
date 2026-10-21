import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { nowIso } from '../../src/shared/ids';
import { countEvents, revokeKey, seedKey, seedThread } from '../helpers';

// Task 0.8: agent auth + PUT /v1/threads/{id}/draft, GET /v1/threads, GET /v1/threads/{id}.

const BASE = 'https://agents.example.com';

function put(threadId: string, key: string | null, body: unknown, raw?: string) {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (key) headers.Authorization = `Bearer ${key}`;
	return SELF.fetch(`${BASE}/v1/threads/${threadId}/draft`, { method: 'PUT', headers, body: raw ?? JSON.stringify(body) });
}

function get(path: string, key: string | null) {
	return SELF.fetch(`${BASE}${path}`, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
}

describe('agent auth', () => {
	it('401s a missing, malformed, unknown or revoked key and logs each refusal', async () => {
		const { threadId } = await seedThread();
		const { id, key } = await seedKey();
		const before = await countEvents('agent.auth_refused');

		expect((await put(threadId, null, { body: 'x' })).status).toBe(401);
		expect((await SELF.fetch(`${BASE}/v1/threads`, { headers: { Authorization: 'Basic abc' } })).status).toBe(401);
		expect((await put(threadId, 'ibx_wrongwrongwrongwrongwrongwrong', { body: 'x' })).status).toBe(401);
		expect((await get('/v1/threads', null)).status).toBe(401);
		expect((await get(`/v1/threads/${threadId}`, null)).status).toBe(401);

		expect((await put(threadId, key, { body: 'first' })).status).toBe(200);
		await revokeKey(id);
		expect((await put(threadId, key, { body: 'second' })).status).toBe(401);
		expect((await get('/v1/threads', key)).status).toBe(401);

		expect(await countEvents('agent.auth_refused')).toBe(before + 7);
	});

	it('has no send route, and unknown /v1 paths 404', async () => {
		const { key } = await seedKey();
		const { threadId } = await seedThread();
		for (const path of ['/v1/send', `/v1/threads/${threadId}/send`, `/v1/drafts/x/send`, '/api/drafts/x/send']) {
			const res = await SELF.fetch(`${BASE}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${key}` } });
			expect(res.status).toBe(404);
		}
		expect((await SELF.fetch(`${BASE}/v1/threads/${threadId}/draft`, { method: 'DELETE', headers: { Authorization: `Bearer ${key}` } })).status).toBe(405);
	});
});

describe('PUT /v1/threads/{id}/draft', () => {
	it('creates the draft, then appends revisions', async () => {
		const { threadId } = await seedThread();
		const { key, label } = await seedKey();
		const a = await put(threadId, key, { body: 'Hi, here is the answer.' });
		expect(a.status).toBe(200);
		const first = await a.json<{ draftId: string; revisionId: string; n: number }>();
		expect(first.n).toBe(1);

		const b = await put(threadId, key, { body: 'Hi, here is a better answer.' });
		const second = await b.json<{ draftId: string; revisionId: string; n: number }>();
		expect(second).toMatchObject({ draftId: first.draftId, n: 2 });

		const draft = await env.DB.prepare('SELECT current_revision_id FROM drafts WHERE id = ?').bind(first.draftId).first<{ current_revision_id: string }>();
		expect(draft!.current_revision_id).toBe(second.revisionId);
		const rev = await env.DB.prepare('SELECT author, body FROM draft_revisions WHERE id = ?').bind(second.revisionId).first();
		expect(rev).toEqual({ author: `agent:${label}`, body: 'Hi, here is a better answer.' });
	});

	it('400s unknown fields, recipient fields, empty or non-JSON bodies, and logs them', async () => {
		const { threadId } = await seedThread();
		const { key } = await seedKey();
		const before = await countEvents('draft.refused');
		for (const body of [{ body: 'x', to: 'evil@example.net' }, { body: 'x', bcc: 'evil@example.net' }, { body: 'x', subject: 's' }, { body: '' }, {}, { body: 42 }]) {
			expect((await put(threadId, key, body)).status).toBe(400);
		}
		expect((await put(threadId, key, null, 'not json')).status).toBe(400);
		expect(await countEvents('draft.refused')).toBe(before + 7);
	});

	it('404s an unknown thread and a thread from another mailbox', async () => {
		const { key } = await seedKey();
		const other = await seedThread({ mailbox: 'someone-else@example.com' });
		expect((await put('0123456789abcdefghjkmnpqrs', key, { body: 'x' })).status).toBe(404);
		expect((await put(other.threadId, key, { body: 'x' })).status).toBe(404);
	});

	it('423s once the owner has edited the draft', async () => {
		const { threadId } = await seedThread();
		const { key } = await seedKey();
		const { draftId } = await (await put(threadId, key, { body: 'agent text' })).json<{ draftId: string }>();
		await env.DB.prepare('UPDATE drafts SET owner_locked = 1 WHERE id = ?').bind(draftId).run();
		const before = await countEvents('draft.refused');
		const res = await put(threadId, key, { body: 'agent overwrite' });
		expect(res.status).toBe(423);
		expect(await res.json()).toEqual({ error: 'owner_edited' });
		expect(await countEvents('draft.refused')).toBe(before + 1);
	});

	it('409s while the draft is sending', async () => {
		const { threadId } = await seedThread();
		const { key } = await seedKey();
		const { draftId } = await (await put(threadId, key, { body: 'agent text' })).json<{ draftId: string }>();
		await env.DB.prepare("UPDATE drafts SET status = 'sending' WHERE id = ?").bind(draftId).run();
		const before = await countEvents('draft.refused');
		expect((await put(threadId, key, { body: 'swap' })).status).toBe(409);
		expect(await countEvents('draft.refused')).toBe(before + 1);
	});

	it('starts a fresh draft after the previous one was sent', async () => {
		const { threadId } = await seedThread();
		const { key } = await seedKey();
		const { draftId } = await (await put(threadId, key, { body: 'one' })).json<{ draftId: string }>();
		await env.DB.prepare("UPDATE drafts SET status = 'sent', closed_at = ? WHERE id = ?").bind(nowIso(), draftId).run();
		const next = await (await put(threadId, key, { body: 'two' })).json<{ draftId: string; n: number }>();
		expect(next.draftId).not.toBe(draftId);
		expect(next.n).toBe(1);
	});
});

describe('GET /v1/threads', () => {
	it('lists threads in this mailbox with derived state, and reads one thread', async () => {
		const { key } = await seedKey();
		const { threadId } = await seedThread({ subject: 'Listed thread' });
		await seedThread({ mailbox: 'someone-else@example.com', subject: 'Other mailbox' });
		const list = await (await get('/v1/threads', key)).json<{ threads: { id: string; subject: string; state: string }[] }>();
		expect(list.threads.find((t) => t.id === threadId)).toMatchObject({ subject: 'Listed thread', state: 'needs_reply' });
		expect(list.threads.some((t) => t.subject === 'Other mailbox')).toBe(false);

		await put(threadId, key, { body: 'draft' });
		const one = await (await get(`/v1/threads/${threadId}`, key)).json<{ thread: { state: string }; messages: unknown[]; draft: unknown }>();
		expect(one.thread.state).toBe('draft_ready');
		expect(one.messages).toHaveLength(1);
		expect(one.draft).toMatchObject({ status: 'open', n: 1, owner_locked: false });
	});
});
