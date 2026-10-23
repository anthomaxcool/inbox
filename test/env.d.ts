/// <reference types="@cloudflare/vitest-plugin/types" />

declare namespace Cloudflare {
	interface Env {
		DB: D1Database;
		R2: R2Bucket;
		MAILBOX: string;
		FORWARD_TO?: string;
		APP_ORIGIN: string;
		OWNER_EMAIL: string;
		ACCESS_TEAM_DOMAIN: string;
		ACCESS_AUD: string;
		TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
	}
}
