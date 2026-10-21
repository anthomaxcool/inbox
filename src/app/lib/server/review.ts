import { replySubject } from '../../../shared/msgid';
import type { AppEnv } from '../../app-env';

// Data for screen 4. TO, FROM and SUBJECT are computed from the thread exactly as send.ts does.

export interface ReviewData {
	thread: { id: string; subject: string; counterpartyName: string | null; mailbox: string };
	envelope: { to: string; from: string; subject: string };
	messages: { id: string; direction: 'in' | 'out'; from: string; date: string; text: string }[];
	draft: { id: string; status: string; ownerLocked: boolean; revisionId: string; n: number; author: string; body: string } | null;
	mailboxMatches: boolean;
}

export async function loadReview(env: AppEnv, threadId: string): Promise<ReviewData | null> {
	const db = env.DB;
	const thread = await db
		.prepare('SELECT id, subject, counterparty_name, reply_to, mailbox FROM threads WHERE id = ?')
		.bind(threadId)
		.first<{ id: string; subject: string; counterparty_name: string | null; reply_to: string; mailbox: string }>();
	if (!thread) return null;
	const messages = await db
		.prepare('SELECT id, direction, from_address, date, text_body FROM messages WHERE thread_id = ? ORDER BY date, created_at')
		.bind(threadId)
		.all<{ id: string; direction: 'in' | 'out'; from_address: string; date: string; text_body: string }>();
	const draft = await db
		.prepare(
			`SELECT d.id, d.status, d.owner_locked, r.id AS revision_id, r.n, r.author, r.body
			 FROM drafts d JOIN draft_revisions r ON r.id = d.current_revision_id
			 WHERE d.thread_id = ? AND d.status IN ('open', 'sending')`
		)
		.bind(threadId)
		.first<{ id: string; status: string; owner_locked: number; revision_id: string; n: number; author: string; body: string }>();
	return {
		thread: { id: thread.id, subject: thread.subject, counterpartyName: thread.counterparty_name, mailbox: thread.mailbox },
		envelope: { to: thread.reply_to, from: env.MAILBOX.toLowerCase(), subject: replySubject(thread.subject.replace(/[\r\n]+/g, ' ')) },
		messages: messages.results.map((m) => ({ id: m.id, direction: m.direction, from: m.from_address, date: m.date, text: m.text_body })),
		draft: draft
			? {
					id: draft.id,
					status: draft.status,
					ownerLocked: draft.owner_locked === 1,
					revisionId: draft.revision_id,
					n: draft.n,
					author: draft.author,
					body: draft.body
				}
			: null,
		mailboxMatches: thread.mailbox === env.MAILBOX.toLowerCase()
	};
}
