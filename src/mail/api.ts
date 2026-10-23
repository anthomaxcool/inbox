import { z } from 'zod';
import { logEvent } from '../shared/events';
import { THREAD_STATE_SQL } from '../shared/threads';
import { authenticateAgent, type AgentKey } from './auth';
import { writeAgentDraft } from './drafts';
import type { MailEnv } from './env';

// The agent API. Read threads, write a draft body. There is no send route here, and this Worker
// has no way to send (plan §8.1, §8.6).

const DraftBody = z.object({ body: z.string().min(1).max(100_000) }).strict();

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

function json(status: number, data: unknown): Response {
	return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function error(status: number, code: string): Response {
	return json(status, { error: code });
}

type Handler = (request: Request, env: MailEnv, key: AgentKey, params: string[]) => Promise<Response>;

interface Route {
	method: string;
	pattern: RegExp;
	name: string;
	handler: Handler;
}

const ID = '([0-9a-hjkmnp-tv-z]{26})';

export const ROUTES: Route[] = [
	{ method: 'GET', pattern: /^\/v1\/threads$/, name: 'threads.list', handler: listThreads },
	{ method: 'GET', pattern: new RegExp(`^/v1/threads/${ID}$`), name: 'threads.get', handler: getThread },
	{ method: 'PUT', pattern: new RegExp(`^/v1/threads/${ID}/draft$`), name: 'draft.put', handler: putDraft }
];

export async function handleAgentApi(request: Request, env: MailEnv): Promise<Response> {
	const url = new URL(request.url);
	if (!url.pathname.startsWith('/v1/')) return error(404, 'not_found');

	const key = await authenticateAgent(request, env.DB, `${request.method} ${url.pathname}`);
	if (!key) return error(401, 'unauthorized');

	for (const route of ROUTES) {
		const match = route.pattern.exec(url.pathname);
		if (!match) continue;
		if (request.method !== route.method) continue;
		return route.handler(request, env, key, match.slice(1));
	}
	const pathKnown = ROUTES.some((r) => r.pattern.test(url.pathname));
	if (pathKnown) {
		await logEvent(env.DB, `agent:${key.label}`, 'agent.method_refused', `${request.method} ${url.pathname}`);
		return error(405, 'method_not_allowed');
	}
	return error(404, 'not_found');
}

async function listThreads(_request: Request, env: MailEnv): Promise<Response> {
	const rows = await env.DB.prepare(
		`SELECT t.id, t.subject, t.counterparty_name, t.last_message_at, ${THREAD_STATE_SQL} AS state,
		 (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS message_count
		 FROM threads t WHERE t.mailbox = ? ORDER BY t.last_message_at DESC LIMIT 50`
	)
		.bind(env.MAILBOX.toLowerCase())
		.all();
	return json(200, { threads: rows.results });
}

async function getThread(_request: Request, env: MailEnv, _key: AgentKey, [id]: string[]): Promise<Response> {
	const thread = await env.DB.prepare(
		`SELECT t.id, t.subject, t.counterparty_name, t.last_message_at, ${THREAD_STATE_SQL} AS state
		 FROM threads t WHERE t.id = ? AND t.mailbox = ?`
	)
		.bind(id, env.MAILBOX.toLowerCase())
		.first();
	if (!thread) return error(404, 'not_found');
	const messages = await env.DB.prepare(
		`SELECT id, direction, from_name, from_address AS "from", "to", cc, date, subject, text_body AS text
		 FROM messages WHERE thread_id = ? ORDER BY date, created_at`
	)
		.bind(id)
		.all<Record<string, unknown> & { to: string; cc: string }>();
	const draft = await env.DB.prepare(
		`SELECT d.status, r.n, r.author, d.owner_locked FROM drafts d
		 LEFT JOIN draft_revisions r ON r.id = d.current_revision_id
		 WHERE d.thread_id = ? AND d.status IN ('open', 'sending')`
	)
		.bind(id)
		.first<{ status: string; n: number; author: string; owner_locked: number }>();
	return json(200, {
		thread,
		messages: messages.results.map((m) => ({ ...m, to: JSON.parse(m.to), cc: JSON.parse(m.cc) })),
		draft: draft ? { ...draft, owner_locked: draft.owner_locked === 1 } : null
	});
}

async function putDraft(request: Request, env: MailEnv, key: AgentKey, [threadId]: string[]): Promise<Response> {
	const actor = `agent:${key.label}` as const;
	let parsed: z.infer<typeof DraftBody>;
	try {
		const result = DraftBody.safeParse(await request.json());
		if (!result.success) throw new Error('invalid');
		parsed = result.data;
	} catch {
		await logEvent(env.DB, actor, 'draft.refused', threadId, 'bad_request');
		return error(400, 'bad_request');
	}
	const thread = await env.DB.prepare('SELECT mailbox FROM threads WHERE id = ?').bind(threadId).first<{ mailbox: string }>();
	if (!thread || thread.mailbox !== env.MAILBOX.toLowerCase()) {
		await logEvent(env.DB, actor, 'draft.refused', threadId, 'thread_not_found');
		return error(404, 'not_found');
	}

	const result = await writeAgentDraft(env.DB, threadId, parsed.body, key);
	if (!result.ok) {
		await logEvent(env.DB, actor, 'draft.refused', threadId, result.error);
		return error(result.status, result.error);
	}
	await logEvent(env.DB, actor, result.created ? 'draft.created' : 'draft.revised', result.draftId, `n=${result.n}`);
	return json(200, { draftId: result.draftId, revisionId: result.revisionId, n: result.n });
}
