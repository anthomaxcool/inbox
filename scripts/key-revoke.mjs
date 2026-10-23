#!/usr/bin/env node
// pnpm key:revoke <label> [--local] [-c <wrangler config>] [--persist-to <dir>]
// Revokes the agent key with this label. It fails on the very next request.
import { d1Exec } from './d1-exec.mjs';
import { revokeKeySql } from './keys-sql.mjs';

const [label, ...rest] = process.argv.slice(2);
try {
	d1Exec(revokeKeySql(label), rest);
	console.error(`Revoked key "${label}".`);
} catch (err) {
	console.error(`key:revoke failed: ${err.message}`);
	process.exit(1);
}
