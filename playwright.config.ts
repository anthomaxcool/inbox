import { defineConfig } from '@playwright/test';

// Screen 4 against `wrangler dev` (task 0.11). test/e2e/prepare.mjs builds with test doubles for
// the Access JWKS and the provider, then wrangler serves it with a local D1.
const PORT = 8799;
const state = '.e2e-state';

export default defineConfig({
	testDir: 'test/e2e',
	timeout: 30_000,
	use: { baseURL: `http://localhost:${PORT}` },
	webServer: {
		command: [
			'node test/e2e/prepare.mjs &&',
			`XDG_CONFIG_HOME=$PWD/${state}/xdg WRANGLER_SEND_METRICS=false`,
			`pnpm exec wrangler dev -c src/app/wrangler.jsonc --port ${PORT} --persist-to ${state}/wrangler`,
			`--var APP_ORIGIN:http://localhost:${PORT} --var OWNER_EMAIL:owner@example.net`,
			'--var ACCESS_TEAM_DOMAIN:team.example.com --var ACCESS_AUD:e2e-aud'
		].join(' '),
		url: `http://localhost:${PORT}/review.js`,
		timeout: 180_000,
		reuseExistingServer: false
	}
});
