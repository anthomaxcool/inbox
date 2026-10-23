import { env } from 'cloudflare:workers';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';

// A locally signed stand-in for the Access team's JWKS.
const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
const other = await generateKeyPair('RS256', { extractable: true });
const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256' };
export const localJwks = createLocalJWKSet({ keys: [jwk] });

export async function accessJwt(claims: JWTPayload = {}, opts: { aud?: string; iss?: string; exp?: string | number; wrongKey?: boolean } = {}) {
	return new SignJWT({ email: env.OWNER_EMAIL, type: 'app', ...claims })
		.setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
		.setIssuer(opts.iss ?? `https://${env.ACCESS_TEAM_DOMAIN}`)
		.setAudience(opts.aud ?? env.ACCESS_AUD)
		.setIssuedAt()
		.setExpirationTime(opts.exp ?? '10m')
		.sign(opts.wrongKey ? other.privateKey : privateKey);
}

/** A service-token JWT: `common_name`, no `email`. */
export async function serviceTokenJwt() {
	return new SignJWT({ common_name: 'abc123.access', type: 'app', sub: '' })
		.setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
		.setIssuer(`https://${env.ACCESS_TEAM_DOMAIN}`)
		.setAudience(env.ACCESS_AUD)
		.setIssuedAt()
		.setExpirationTime('10m')
		.sign(privateKey);
}
