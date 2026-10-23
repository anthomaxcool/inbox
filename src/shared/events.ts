import { nowIso, randomId } from './ids';

export type Actor = 'owner' | 'system' | 'anonymous' | `agent:${string}`;

export function eventStatement(
	db: D1Database,
	actor: Actor,
	kind: string,
	ref: string | null = null,
	detail: string | null = null
): D1PreparedStatement {
	return db
		.prepare('INSERT INTO events (id, at, actor, kind, ref, detail) VALUES (?, ?, ?, ?, ?, ?)')
		.bind(randomId(), nowIso(), actor, kind, ref, detail);
}

/** Append one row to the audit log. Never throws: a failed log write must not change the response. */
export async function logEvent(
	db: D1Database,
	actor: Actor,
	kind: string,
	ref: string | null = null,
	detail: string | null = null
): Promise<void> {
	try {
		await eventStatement(db, actor, kind, ref, detail).run();
	} catch (err) {
		console.error('event log write failed', kind, (err as Error).message);
	}
}
