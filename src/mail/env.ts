// inbox-mail bindings. This Worker has no send credential and no send code (plan §8.1).
export interface MailEnv {
	DB: D1Database;
	R2: R2Bucket;
	/** The one mailbox this copy serves, e.g. support@example.com. Build variable. */
	MAILBOX: string;
	/** Personal address that gets a safety copy of every inbound mail. Secret. Skipped when unset. */
	FORWARD_TO?: string;
}
