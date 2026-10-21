import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../src/app/env';
import { handleOwnerApi, type OwnerApiDeps } from '../../src/app/lib/server/owner-api';
import { countEvents, seedKey } from '../helpers';
import { accessJwt, localJwks, serviceTokenJwt } from './jwt';

// Task 0.9 / plan §8.2: the owner guard on every /api route. Each refusal returns 401/403/400,
// writes an events row, and never reaches the send function.

const appEnv = env as unknown as AppEnv;
const DRAFT = '0123456789abcdefghjkmnpqrs';
const URL_SEND = `${env.APP_ORIGIN}/api/drafts/${DRAFT}/send`;
const GOOD_BODY = JSON.stringify({ draftId: DRAFT, revisionId: 'abcdefghjkmnpqrs0123456789', idempotencyKey: crypto.randomUUID() });

function deps() {
	const send = vi.fn(async () => ({ status: 200 as const, body: { status: 'sent' as const, sendAttemptId: 'x' } }));
	const d: OwnerApiDeps = { jwks: () => localJwks, send };
	return { d, send };
}

async function sendRequest(headers: Record<string, string>, body = GOOD_BODY) {
	return new Request(URL_SEND, { method: 'POST', headers, body });
}

async function goodHeaders(jwt?: string): Promise<Record<string, string>> {
	return {
		'Cf-Access-Jwt-Assertion': jwt ?? (await accessJwt()),
		Origin: env.APP_ORIGIN,
		'Content-Type': 'application/json',
		'X-Inbox-Intent': 'send'
	};
}

describe('owner guard on POST /api/drafts/{id}/send', () => {
	const cases: [string, () => Promise<Request>, number][] = [
		['no JWT', async () => sendRequest({ ...(await goodHeaders()), 'Cf-Access-Jwt-Assertion': '' }), 401],
		['a bad signature', async () => sendRequest(await goodHeaders(await accessJwt({}, { wrongKey: true }))), 401],
		['the wrong aud', async () => sendRequest(await goodHeaders(await accessJwt({}, { aud: 'another-app' }))), 401],
		['the wrong iss', async () => sendRequest(await goodHeaders(await accessJwt({}, { iss: 'https://evil.example.com' }))), 401],
		['an expired JWT', async () => sendRequest(await goodHeaders(await accessJwt({}, { exp: Math.floor(Date.now() / 1000) - 60 }))), 401],
		['a garbage JWT', async () => sendRequest(await goodHeaders('not.a.jwt')), 401],
		['the wrong email', async () => sendRequest(await goodHeaders(await accessJwt({ email: 'someone@example.net' }))), 403],
		['a service-token JWT', async () => sendRequest(await goodHeaders(await serviceTokenJwt())), 403],
		['a service-token JWT that also carries the owner email', async () => sendRequest(await goodHeaders(await accessJwt({ common_name: 'abc.access' }))), 403],
		['the wrong origin', async () => sendRequest({ ...(await goodHeaders()), Origin: 'https://evil.example.com' }), 403],
		['no origin', async () => {
			const h = await goodHeaders();
			delete h.Origin;
			return sendRequest(h);
		}, 403],
		['a form content type', async () => sendRequest({ ...(await goodHeaders()), 'Content-Type': 'application/x-www-form-urlencoded' }), 400],
		['a missing intent header', async () => {
			const h = await goodHeaders();
			delete h['X-Inbox-Intent'];
			return sendRequest(h);
		}, 400],
		['the save intent on send', async () => sendRequest({ ...(await goodHeaders()), 'X-Inbox-Intent': 'save' }), 400],
		['extra body fields', async () => sendRequest(await goodHeaders(), JSON.stringify({ ...JSON.parse(GOOD_BODY), to: 'evil@example.net' })), 400],
		['a body for another draft', async () => sendRequest(await goodHeaders(), JSON.stringify({ ...JSON.parse(GOOD_BODY), draftId: 'zzzzzzzzzzzzzzzzzzzzzzzzzz' })), 400]
	];

	for (const [name, build, status] of cases) {
		it(`refuses ${name} with ${status}, logs it, and never sends`, async () => {
			const { d, send } = deps();
			const before = await countEvents();
			const res = await handleOwnerApi(await build(), appEnv, d);
			expect(res.status).toBe(status);
			expect(await countEvents()).toBe(before + 1);
			expect(send).not.toHaveBeenCalled();
		});
	}

	it('refuses a valid agent key: inbox-app never reads Authorization', async () => {
		const { key } = await seedKey();
		const { d, send } = deps();
		const before = await countEvents();
		const res = await handleOwnerApi(
			await sendRequest({ Authorization: `Bearer ${key}`, Origin: env.APP_ORIGIN, 'Content-Type': 'application/json', 'X-Inbox-Intent': 'send' }),
			appEnv,
			d
		);
		expect(res.status).toBe(401);
		expect(await countEvents()).toBe(before + 1);
		expect(send).not.toHaveBeenCalled();
	});

	it('passes the owner with every check satisfied', async () => {
		const { d, send } = deps();
		const res = await handleOwnerApi(await sendRequest(await goodHeaders()), appEnv, d);
		expect(res.status).toBe(200);
		expect(send).toHaveBeenCalledOnce();
	});

	it('guards GET routes and unknown routes too', async () => {
		const { d } = deps();
		expect((await handleOwnerApi(new Request(`${env.APP_ORIGIN}/api/threads/${DRAFT}`), appEnv, d)).status).toBe(401);
		expect((await handleOwnerApi(new Request(`${env.APP_ORIGIN}/api/anything`), appEnv, d)).status).toBe(401);
		const ok = await handleOwnerApi(new Request(`${env.APP_ORIGIN}/api/anything`, { headers: { 'Cf-Access-Jwt-Assertion': await accessJwt() } }), appEnv, d);
		expect(ok.status).toBe(404);
	});
});
