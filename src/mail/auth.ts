import { logEvent } from '../shared/events';
import { nowIso, sha256Hex } from '../shared/ids';

export interface AgentKey {
	id: string;
	label: string;
}

const BEARER = /^Bearer ([A-Za-z0-9_-]{20,200})$/;

/**
 * Per-agent bearer key, stored as SHA-256 only (plan §8.6). A revoked key fails on the very next request.
 * Every refusal writes one `events` row.
 */
export async function authenticateAgent(request: Request, db: D1Database, route: string): Promise<AgentKey | null> {
	const header = request.headers.get('Authorization');
	const match = header ? BEARER.exec(header) : null;
	if (!match) {
		await logEvent(db, 'anonymous', 'agent.auth_refused', route, header ? 'malformed' : 'missing');
		return null;
	}
	const hash = await sha256Hex(match[1]);
	const row = await db
		.prepare('SELECT id, label, revoked_at FROM agent_keys WHERE key_hash = ?')
		.bind(hash)
		.first<{ id: string; label: string; revoked_at: string | null }>();
	if (!row) {
		await logEvent(db, 'anonymous', 'agent.auth_refused', route, 'unknown_key');
		return null;
	}
	if (row.revoked_at) {
		await logEvent(db, `agent:${row.label}`, 'agent.auth_refused', route, 'revoked');
		return null;
	}
	await db.prepare('UPDATE agent_keys SET last_used_at = ? WHERE id = ?').bind(nowIso(), row.id).run();
	return { id: row.id, label: row.label };
}
