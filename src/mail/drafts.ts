import { nowIso, randomId, sha256Hex } from '../shared/ids';
import type { AgentKey } from './auth';

export type AgentDraftResult =
	| { ok: true; draftId: string; revisionId: string; n: number; created: boolean }
	| { ok: false; status: 404; error: 'thread_not_found' }
	| { ok: false; status: 409; error: 'draft_sending' | 'draft_busy' }
	| { ok: false; status: 423; error: 'owner_edited' };

interface LiveDraft {
	id: string;
	status: 'open' | 'sending';
	owner_locked: number;
}

function isUniqueViolation(err: unknown): boolean {
	return /UNIQUE constraint failed/i.test((err as Error)?.message ?? '');
}

/**
 * Create the thread's draft or append an agent revision. Body only: recipients, subject and
 * headers are never stored on a draft (plan §7). Refuses while the draft is `sending` (409) and
 * once the owner has edited it (423).
 */
export async function writeAgentDraft(
	db: D1Database,
	threadId: string,
	body: string,
	key: AgentKey
): Promise<AgentDraftResult> {
	const thread = await db.prepare('SELECT id FROM threads WHERE id = ?').bind(threadId).first();
	if (!thread) return { ok: false, status: 404, error: 'thread_not_found' };

	const sha = await sha256Hex(body);
	const author = `agent:${key.label}`;

	for (let attempt = 0; attempt < 5; attempt++) {
		const live = await db
			.prepare("SELECT id, status, owner_locked FROM drafts WHERE thread_id = ? AND status IN ('open', 'sending')")
			.bind(threadId)
			.first<LiveDraft>();
		const now = nowIso();
		const revisionId = randomId();

		if (!live) {
			const draftId = randomId();
			try {
				await db.batch([
					db
						.prepare(
							"INSERT INTO drafts (id, thread_id, status, owner_locked, current_revision_id, created_at) VALUES (?, ?, 'open', 0, ?, ?)"
						)
						.bind(draftId, threadId, revisionId, now),
					db
						.prepare(
							'INSERT INTO draft_revisions (id, draft_id, n, body, body_sha256, author, agent_key_id, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)'
						)
						.bind(revisionId, draftId, body, sha, author, key.id, now)
				]);
				return { ok: true, draftId, revisionId, n: 1, created: true };
			} catch (err) {
				if (isUniqueViolation(err)) continue; // another writer created the draft first
				throw err;
			}
		}

		if (live.status === 'sending') return { ok: false, status: 409, error: 'draft_sending' };
		if (live.owner_locked) return { ok: false, status: 423, error: 'owner_edited' };

		// One transaction: the revision lands and becomes current only if the draft is still open and agent-writable.
		let results: D1Result[];
		try {
			results = await db.batch([
				db
					.prepare(
						`INSERT INTO draft_revisions (id, draft_id, n, body, body_sha256, author, agent_key_id, created_at)
						 SELECT ?, d.id, (SELECT COALESCE(MAX(n), 0) + 1 FROM draft_revisions WHERE draft_id = d.id), ?, ?, ?, ?, ?
						 FROM drafts d WHERE d.id = ? AND d.status = 'open' AND d.owner_locked = 0`
					)
					.bind(revisionId, body, sha, author, key.id, now, live.id),
				db
					.prepare(
						`UPDATE drafts SET current_revision_id = ?
						 WHERE id = ? AND status = 'open' AND owner_locked = 0 AND EXISTS (SELECT 1 FROM draft_revisions WHERE id = ?)`
					)
					.bind(revisionId, live.id, revisionId)
			]);
		} catch (err) {
			if (isUniqueViolation(err)) continue;
			throw err;
		}
		if (results[0].meta.changes === 1) {
			const row = await db.prepare('SELECT n FROM draft_revisions WHERE id = ?').bind(revisionId).first<{ n: number }>();
			return { ok: true, draftId: live.id, revisionId, n: row?.n ?? 0, created: false };
		}
		// The draft changed under us (now sending, owner-locked, or closed). Re-read and decide.
	}
	return { ok: false, status: 409, error: 'draft_busy' };
}
