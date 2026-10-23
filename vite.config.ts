import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// inbox-app. The deploy build uses this file only. The Playwright build (vite.e2e.config.ts) swaps
// the JWKS and the provider for test doubles and is never deployed (`pnpm check:config`).
export default defineConfig({
	plugins: [
		sveltekit({
			files: { src: 'src/app' },
			compilerOptions: { runes: true },
			adapter: adapter({
				// Rendered from src/app/wrangler.template.jsonc by scripts/render-wrangler.mjs.
				config: 'src/app/wrangler.jsonc'
			})
		})
	]
});
