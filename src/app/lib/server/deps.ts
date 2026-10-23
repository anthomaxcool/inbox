import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import type { AppEnv } from '../../app-env';
import { sendDraft, type SendEnv } from '../../send';
import { accessTeamHost } from './guard';
import type { OwnerApiDeps } from './owner-api';

// Production wiring: the Access team's live JWKS, and the real provider.
const jwksByTeam = new Map<string, JWTVerifyGetKey>();

// Only called after ownerGuard has checked that ACCESS_TEAM_DOMAIN is a hostname.
function teamJwks(env: AppEnv): JWTVerifyGetKey {
	const host = accessTeamHost(env.ACCESS_TEAM_DOMAIN) ?? 'invalid.invalid';
	let jwks = jwksByTeam.get(host);
	if (!jwks) {
		jwks = createRemoteJWKSet(new URL(`https://${host}/cdn-cgi/access/certs`));
		jwksByTeam.set(host, jwks);
	}
	return jwks;
}

export function ownerApiDeps(env: AppEnv): OwnerApiDeps {
	return {
		jwks: teamJwks,
		send: (req) => sendDraft(env as unknown as SendEnv, req)
	};
}
