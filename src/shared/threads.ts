// Thread state is derived, not stored (plan §7).
export type ThreadState = 'archived' | 'draft_ready' | 'sent' | 'needs_reply';

export const THREAD_STATE_SQL = `CASE
	WHEN t.archived_at IS NOT NULL THEN 'archived'
	WHEN EXISTS (SELECT 1 FROM drafts d WHERE d.thread_id = t.id AND d.status = 'open') THEN 'draft_ready'
	WHEN t.last_direction = 'out' THEN 'sent'
	ELSE 'needs_reply'
END`;
