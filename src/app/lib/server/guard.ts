import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import { logEvent, type Actor } from '../../../shared/events';
import type { AppEnv } from '../../env';

// The owner guard (plan §8.2). One function, run on every request to inbox-app.
// It verifies the Access JWT itself and never trusts that Access ran. It never reads
// an `Authorization` header, so agent keys mean nothing here.

export type Intent = 'send' | 'save';

export type GuardResult = { ok: true; email: string } | { ok: false; response: Response };

export interface GuardDeps {
	jwks: (env: AppEnv) => JWTVerifyGetKey;
}

function refuse(status: number, code: string): GuardResult {
	return {
		ok: false,
		response: new Response(JSON.stringify({ error: code }), {
			status,
			headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
		})
	};
}

export async function ownerGuard(
	request: Request,
	env: AppEnv,
	deps: GuardDeps,
	mutation: { intent: Intent } | null
): Promise<GuardResult> {
	const route = `${request.method} ${new URL(request.url).pathname}`;
	const deny = async (status: number, code: string, actor: Actor = 'anonymous') => {
		await logEvent(env.DB, actor, 'owner.refused', route, code);
		return refuse(status, code);
	};

	const token = request.headers.get('Cf-Access-Jwt-Assertion');
	if (!token) return deny(401, 'no_access_jwt');

	let payload: Record<string, unknown>;
	try {
		({ payload } = await jwtVerify(token, deps.jwks(env), {
			issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
			audience: env.ACCESS_AUD,
			algorithms: ['RS256'],
			requiredClaims: ['exp', 'iat']
		}));
	} catch (err) {
		return deny(401, `bad_access_jwt:${(err as { code?: string }).code ?? 'invalid'}`);
	}

	// A service-token JWT has `common_name` and no `email`. Refused even if Access let it through.
	if ('common_name' in payload || typeof payload.email !== 'string' || payload.email === '') {
		return deny(403, 'service_token');
	}
	if (payload.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) return deny(403, 'not_owner');

	if (mutation) {
		// Blocks cross-site form posts that ride the Access cookie.
		if (request.headers.get('Origin') !== env.APP_ORIGIN) return deny(403, 'bad_origin', 'owner');
		const contentType = request.headers.get('Content-Type') ?? '';
		if (!/^application\/json(\s*;|$)/i.test(contentType)) return deny(400, 'bad_content_type', 'owner');
		if (request.headers.get('X-Inbox-Intent') !== mutation.intent) return deny(400, 'missing_intent', 'owner');
	}
	return { ok: true, email: payload.email };
}
