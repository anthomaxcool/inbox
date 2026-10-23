#!/usr/bin/env node
// pnpm key:create <label> [--local] [-c <wrangler config>] [--persist-to <dir>]
// Creates an agent key, stores only its SHA-256, and prints the key once. Store it straight into
// the agent's secret store (a Paperclip secret). It is never shown again.
import { d1Exec } from './d1-exec.mjs';
import { createKeySql, makeKey } from './keys-sql.mjs';

const [label, ...rest] = process.argv.slice(2);
try {
	const key = makeKey();
	d1Exec(await createKeySql(label, key), rest);
	process.stderr.write(`Created key "${label}". Shown once, store it now:\n`);
	process.stdout.write(`${key}\n`);
} catch (err) {
	console.error(`key:create failed: ${err.message}`);
	process.exit(1);
}
