import { error } from '@sveltejs/kit';
import { appEnv } from '#lib/server/platform';
import { loadReview } from '#lib/server/review';
import type { PageServerLoad } from './$types';

// hooks.server.ts has already run ownerGuard for this request.
export const load: PageServerLoad = async ({ params }) => {
	if (!/^[0-9a-hjkmnp-tv-z]{26}$/.test(params.threadId)) error(404, 'Not found');
	const review = await loadReview(appEnv(), params.threadId);
	if (!review) error(404, 'Not found');
	return { review };
};
