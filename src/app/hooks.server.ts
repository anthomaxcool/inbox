import type { Handle } from '@sveltejs/kit/hooks';
import { ownerApiDeps } from '#lib/server/deps.ts';
import { ownerGuard } from '#lib/server/guard.ts';
import { withSecurityHeaders } from '#lib/server/headers.ts';
import { appEnv } from '#lib/server/platform.ts';

// Pages go through ownerGuard here. /api routes run it inside handleOwnerApi, with the
// mutation checks for their intent. Every response gets the §8.11 headers.
export const handle: Handle = async ({ event, resolve }) => {
	if (!event.url.pathname.startsWith('/api/')) {
		const env = appEnv();
		const guard = await ownerGuard(event.request, env, ownerApiDeps(env), null);
		if (!guard.ok) return withSecurityHeaders(guard.response);
	}
	return withSecurityHeaders(await resolve(event));
};
