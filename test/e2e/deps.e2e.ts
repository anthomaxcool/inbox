import { createLocalJWKSet } from 'jose';
import type { AppEnv } from '../../src/app/app-env';
import type { OwnerApiDeps } from '../../src/app/lib/server/owner-api';
import { sendDraft, type SendEnv } from '../../src/app/send';

// Test doubles for the Playwright build (vite.e2e.config.ts).
declare const __E2E_JWKS__: string;
const jwks = createLocalJWKSet(JSON.parse(__E2E_JWKS__));

const fakeProvider = (async () => Response.json({ id: `e2e_${crypto.randomUUID()}` })) as unknown as typeof fetch;

export function ownerApiDeps(env: AppEnv): OwnerApiDeps {
	return {
		jwks: () => jwks,
		send: (req) => sendDraft({ ...(env as unknown as SendEnv), RESEND_API_KEY: 'e2e-not-a-key' }, req, fakeProvider)
	};
}
