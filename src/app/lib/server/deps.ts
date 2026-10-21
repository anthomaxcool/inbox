import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import type { AppEnv } from '../../app-env';
import { sendDraft, type SendEnv } from '../../send';
import type { OwnerApiDeps } from './owner-api';

// Production wiring: the Access team's live JWKS, and the real provider.
const jwksByTeam = new Map<string, JWTVerifyGetKey>();

function teamJwks(env: AppEnv): JWTVerifyGetKey {
	let jwks = jwksByTeam.get(env.ACCESS_TEAM_DOMAIN);
	if (!jwks) {
		jwks = createRemoteJWKSet(new URL(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`));
		jwksByTeam.set(env.ACCESS_TEAM_DOMAIN, jwks);
	}
	return jwks;
}

export function ownerApiDeps(env: AppEnv): OwnerApiDeps {
	return {
		jwks: teamJwks,
		send: (req) => sendDraft(env as unknown as SendEnv, req)
	};
}
