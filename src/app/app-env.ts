// inbox-app bindings, minus the send key. Only src/app/send.ts declares or reads that one (plan §8.1).
export interface AppEnv {
	DB: D1Database;
	R2: R2Bucket;
	/** The one mailbox this copy sends from. Build variable. */
	MAILBOX: string;
	/** https://<app host>. Build variable. Mutations must carry this exact Origin. */
	APP_ORIGIN: string;
	/** Secrets set by the owner in Cloudflare. */
	OWNER_EMAIL: string;
	ACCESS_TEAM_DOMAIN: string;
	ACCESS_AUD: string;
}
