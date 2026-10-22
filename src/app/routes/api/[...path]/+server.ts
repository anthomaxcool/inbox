import type { RequestHandler } from '@sveltejs/kit';
import { ownerApiDeps } from '#lib/server/deps.ts';
import { handleOwnerApi } from '#lib/server/owner-api.ts';
import { appEnv } from '#lib/server/platform.ts';

// Every /api request goes to handleOwnerApi, which runs ownerGuard first.
const handler: RequestHandler = async ({ request }) => {
	const env = appEnv();
	return handleOwnerApi(request, env, ownerApiDeps(env));
};

export const GET = handler;
export const POST = handler;
export const fallback = handler;
