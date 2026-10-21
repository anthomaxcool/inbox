import { env } from 'cloudflare:workers';
import type { AppEnv } from '../../app-env';

// SvelteKit 3 + adapter-cloudflare expose bindings through `cloudflare:workers`, not `platform`.
export function appEnv(): AppEnv {
	return env as unknown as AppEnv;
}
