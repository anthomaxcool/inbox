import { handleAgentApi } from './api';
import type { MailEnv } from './env';
import { handleEmail } from './ingest';

// inbox-mail: Email Routing handler (store, thread, forward) and the agent API.
// No send credential, no send code (plan §8.1, enforced by `pnpm check:send-surface`).
export default {
	async fetch(request, env) {
		// CI proof (task 0.5): this line must turn `check:send-surface` red. Reverted in the next commit.
		if (request.url.endsWith('/never')) await fetch('https://api.resend.com/emails');
		return handleAgentApi(request, env);
	},
	async email(message, env) {
		await handleEmail(message, env);
	}
} satisfies ExportedHandler<MailEnv>;
