import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd (Workers runtime), with a local D1 and R2 per test file.
// Bindings mirror the wrangler templates. Values here are test fixtures, not instance values.
const COMPATIBILITY_DATE = '2026-10-01';

export default defineConfig(async () => {
	const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
	const shared = {
		compatibilityDate: COMPATIBILITY_DATE,
		d1Databases: ['DB'],
		r2Buckets: ['R2'],
		bindings: { MAILBOX: 'inbox-test@example.com', TEST_MIGRATIONS: migrations }
	};
	return {
		test: {
			projects: [
				{
					plugins: [
						cloudflareTest({
							main: './src/mail/index.ts',
							miniflare: { ...shared, bindings: { ...shared.bindings, FORWARD_TO: 'owner@example.net' } }
						})
					],
					test: { name: 'mail', include: ['test/mail/**/*.test.ts', 'test/shared/**/*.test.ts'], setupFiles: ['./test/apply-migrations.ts'] }
				},
				{
					plugins: [
						cloudflareTest({
							miniflare: {
								...shared,
								compatibilityFlags: ['nodejs_compat'],
								bindings: {
									...shared.bindings,
									APP_ORIGIN: 'https://inbox.example.com',
									OWNER_EMAIL: 'owner@example.net',
									ACCESS_TEAM_DOMAIN: 'team.example.com',
									ACCESS_AUD: 'test-aud'
								}
							}
						})
					],
					test: { name: 'app', include: ['test/app/**/*.test.ts'], setupFiles: ['./test/apply-migrations.ts'] }
				},
				{
					test: { name: 'node', include: ['test/node/**/*.test.ts'], environment: 'node' }
				}
			]
		}
	};
});
