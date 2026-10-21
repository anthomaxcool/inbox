import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// Playwright build only. Swaps #lib/server/deps for test doubles: a JWKS generated fresh for each
// run by test/e2e/prepare.mjs, and a provider that records instead of sending. Never deployed:
// `pnpm deploy:app` builds with vite.config.ts, and `pnpm check:config` enforces that.
const e2eDeps = fileURLToPath(new URL('./test/e2e/deps.e2e.ts', import.meta.url));

function swapDeps(): Plugin {
	return {
		name: 'inbox-e2e-deps',
		enforce: 'pre',
		resolveId(id) {
			if (id === '#lib/server/deps') return e2eDeps;
		}
	};
}

const jwks = process.env.E2E_JWKS;
if (!jwks) throw new Error('E2E_JWKS is not set. Run through test/e2e/prepare.mjs.');

export default defineConfig({
	define: { __E2E_JWKS__: JSON.stringify(jwks) },
	plugins: [
		swapDeps(),
		sveltekit({
			files: { src: 'src/app' },
			compilerOptions: { runes: true },
			adapter: adapter({ config: 'src/app/wrangler.jsonc' })
		})
	]
});
