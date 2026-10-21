import { z } from 'zod';
import { eventStatement, logEvent } from '../../../shared/events';
import { nowIso, randomId, sha256Hex } from '../../../shared/ids';
import type { AppEnv } from '../../app-env';
import type { SendOutcome, SendRequest } from '../../send';
import { ownerGuard, type GuardDeps, type Intent } from './guard';
import { loadReview } from './review';

// The owner API. Every route runs ownerGuard first, then validates an exact body.

export interface OwnerApiDeps extends GuardDeps {
	send: (req: SendRequest) => Promise<SendOutcome>;
}

const ID = z.string().regex(/^[0-9a-hjkmnp-tv-z]{26}$/);
const SendBody = z.object({ draftId: ID, revisionId: ID, idempotencyKey: z.uuid() }).strict();
const SaveBody = z.object({ body: z.string().min(1).max(100_000) }).strict();

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

function json(status: number, data: unknown): Response {
	return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

interface Route {
	method: 'GET' | 'POST';
	pattern: RegExp;
	intent: Intent | null;
	handler: (request: Request, env: AppEnv, deps: OwnerApiDeps, id: string) => Promise<Response>;
}

const IDP = '([0-9a-hjkmnp-tv-z]{26})';
const ROUTES: Route[] = [
	{ method: 'POST', pattern: new RegExp(`^/api/drafts/${IDP}/send$`), intent: 'send', handler: postSend },
	{ method: 'POST', pattern: new RegExp(`^/api/drafts/${IDP}/revisions$`), intent: 'save', handler: postRevision },
	{ method: 'GET', pattern: new RegExp(`^/api/threads/${IDP}$`), intent: null, handler: getThread }
];

export async function handleOwnerApi(request: Request, env: AppEnv, deps: OwnerApiDeps): Promise<Response> {
	const { pathname } = new URL(request.url);
	const route = ROUTES.find((r) => r.method === request.method && r.pattern.test(pathname));
	// Unknown routes still go through the guard, so probing them needs an owner session too.
	const guard = await ownerGuard(request, env, deps, route?.intent ? { intent: route.intent } : null);
	if (!guard.ok) return guard.response;
	if (!route) return json(404, { error: 'not_found' });
	return route.handler(request, env, deps, route.pattern.exec(pathname)![1]);
}

async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<T | null> {
	try {
		const parsed = schema.safeParse(await request.json());
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

async function postSend(request: Request, env: AppEnv, deps: OwnerApiDeps, draftId: string): Promise<Response> {
	const body = await readBody(request, SendBody);
	if (!body || body.draftId !== draftId) {
		await logEvent(env.DB, 'owner', 'send.refused', draftId, 'bad_request');
		return json(400, { error: 'bad_request' });
	}
	const outcome = await deps.send(body);
	return json(outcome.status, outcome.body);
}

async function postRevision(request: Request, env: AppEnv, _deps: OwnerApiDeps, draftId: string): Promise<Response> {
	const body = await readBody(request, SaveBody);
	if (!body) {
		await logEvent(env.DB, 'owner', 'draft.refused', draftId, 'bad_request');
		return json(400, { error: 'bad_request' });
	}
	const db = env.DB;
	const revisionId = randomId();
	const now = nowIso();
	// An owner revision locks the draft against agents for good (owner_locked never goes back).
	const [insert] = await db.batch([
		db
			.prepare(
				`INSERT INTO draft_revisions (id, draft_id, n, body, body_sha256, author, agent_key_id, created_at)
				 SELECT ?, d.id, (SELECT COALESCE(MAX(n), 0) + 1 FROM draft_revisions WHERE draft_id = d.id), ?, ?, 'owner', NULL, ?
				 FROM drafts d WHERE d.id = ? AND d.status = 'open'`
			)
			.bind(revisionId, body.body, await sha256Hex(body.body), now, draftId),
		db
			.prepare(
				`UPDATE drafts SET current_revision_id = ?, owner_locked = 1
				 WHERE id = ? AND status = 'open' AND EXISTS (SELECT 1 FROM draft_revisions WHERE id = ?)`
			)
			.bind(revisionId, draftId, revisionId),
		eventStatement(db, 'owner', 'draft.owner_revision', draftId, revisionId)
	]);
	if (insert.meta.changes !== 1) {
		const draft = await db.prepare('SELECT status FROM drafts WHERE id = ?').bind(draftId).first<{ status: string }>();
		const [status, code] = !draft ? [404, 'not_found'] : draft.status === 'sending' ? [409, 'draft_sending'] : [410, 'draft_closed'];
		await logEvent(db, 'owner', 'draft.refused', draftId, code);
		return json(status, { error: code });
	}
	const rev = await db.prepare('SELECT n FROM draft_revisions WHERE id = ?').bind(revisionId).first<{ n: number }>();
	return json(200, { draftId, revisionId, n: rev?.n });
}

async function getThread(_request: Request, env: AppEnv, _deps: OwnerApiDeps, threadId: string): Promise<Response> {
	const review = await loadReview(env, threadId);
	return review ? json(200, review) : json(404, { error: 'not_found' });
}
