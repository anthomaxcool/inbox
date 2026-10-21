import { handleAgentApi } from './api';
import type { MailEnv } from './env';
import { handleEmail } from './ingest';

// inbox-mail: Email Routing handler (store, thread, forward) and the agent API.
// No send credential, no send code (plan §8.1, enforced by `pnpm check:send-surface`).
export default {
	async fetch(request, env) {
		return handleAgentApi(request, env);
	},
	async email(message, env) {
		await handleEmail(message, env);
	}
} satisfies ExportedHandler<MailEnv>;
