import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../src/app/app-env';
import { handleOwnerApi, type OwnerApiDeps } from '../../src/app/lib/server/owner-api';
import { sendDraft } from '../../src/app/send';
import { writeAgentDraft } from '../../src/mail/drafts';
import { localJwks, serviceTokenJwt } from '../app/jwt';
import { countEvents, seedKey, seedThread } from '../helpers';

// Task 0.17: the owner-app attacks from the Phase 0 red-team (NEX-41 `redteam` log).
// The live half (Access answers 302 before the Worker runs) can't run here; these cover the
// Worker's own refusal behind it. See test/redteam.md.

const appEnv = env as unknown as AppEnv;
const DRAFT = '0123456789abcdefghjkmnpqrs';
const SEND_BODY = JSON.stringify({ draftId: DRAFT, revisionId: 'abcdefghjkmnpqrs0123456789', idempotencyKey: crypto.randomUUID() });

function deps() {
	const send = vi.fn(async () => ({ status: 200 as const, body: { status: 'sent' as const, sendAttemptId: 'x' } }));
	const d: OwnerApiDeps = { jwks: () => localJwks, send };
	return { d, send };
}

describe('red-team SD4: only the owner reaches the send path', () => {
	it('refuses a support-agent bearer on every owner route Atlas tried, and never sends', async () => {
		const { key } = await seedKey();
		const { d, send } = deps();
		const headers = { Authorization: `Bearer ${key}`, Origin: env.APP_ORIGIN, 'Content-Type': 'application/json', 'X-Inbox-Intent': 'send' };
		const before = await countEvents();
		const sendRes = await handleOwnerApi(new Request(`${env.APP_ORIGIN}/api/drafts/${DRAFT}/send`, { method: 'POST', headers, body: SEND_BODY }), appEnv, d);
		const readRes = await handleOwnerApi(new Request(`${env.APP_ORIGIN}/api/threads/x`, { headers }), appEnv, d);
		expect(sendRes.status).toBe(401);
		expect(readRes.status).toBe(401);
		expect(await countEvents()).toBe(before + 2);
		expect(send).not.toHaveBeenCalled();
	});

	it('refuses an Access service-token JWT with 403 and never sends', async () => {
		const { d, send } = deps();
		const res = await handleOwnerApi(
			new Request(`${env.APP_ORIGIN}/api/drafts/${DRAFT}/send`, {
				method: 'POST',
				headers: { 'Cf-Access-Jwt-Assertion': await serviceTokenJwt(), Origin: env.APP_ORIGIN, 'Content-Type': 'application/json', 'X-Inbox-Intent': 'send' },
				body: SEND_BODY
			}),
			appEnv,
			d
		);
		expect(res.status).toBe(403);
		expect(send).not.toHaveBeenCalled();
	});
});

describe('red-team SD7: a hostile inbound subject cannot add recipients or headers', () => {
	it('collapses CRLF in the thread subject and sends to the thread counterparty only', async () => {
		const subject = 'Invoice\r\nBcc: target@example.net\r\nX-Evil: 1';
		const { threadId } = await seedThread({ subject, replyTo: 'customer@example.org' });
		const key = await seedKey();
		const draft = await writeAgentDraft(env.DB, threadId, 'Answer', key);
		if (!draft.ok) throw new Error('seed draft failed');

		const payloads: Record<string, unknown>[] = [];
		const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
			payloads.push(JSON.parse(String(init?.body)));
			return Response.json({ id: 're_1' });
		}) as typeof fetch;
		const r = await sendDraft(
			{ DB: env.DB, MAILBOX: env.MAILBOX, RESEND_API_KEY: 'test-key-not-real' },
			{ draftId: draft.draftId, revisionId: draft.revisionId, idempotencyKey: crypto.randomUUID() },
			fetchFn
		);
		expect(r.status).toBe(200);
		expect(payloads).toHaveLength(1);
		const p = payloads[0] as { to: string[]; subject: string; headers: Record<string, string> };
		expect(Object.keys(p).sort()).toEqual(['from', 'headers', 'subject', 'text', 'to']);
		expect(p.to).toEqual(['customer@example.org']);
		expect(p.subject).not.toMatch(/[\r\n]/);
		expect(Object.keys(p.headers).sort()).toEqual(['In-Reply-To', 'Message-ID', 'References']);
	});
});
