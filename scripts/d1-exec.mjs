// Runs one SQL statement on the Inbox D1 with the owner's own wrangler login.
// The agent host has no Cloudflare login by design, so on that host only --local works.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// Run wrangler's JS entry with this Node, not `pnpm exec`: on Windows pnpm is a .cmd shim that
// execFileSync can't start without a shell, and a shell would re-quote the SQL.
const wranglerPkg = createRequire(import.meta.url).resolve('wrangler/package.json');
const wrangler = join(dirname(wranglerPkg), 'bin', 'wrangler.js');

export function d1Exec(sql, argv) {
	const local = argv.includes('--local');
	const config = argv.includes('-c') ? ['-c', argv[argv.indexOf('-c') + 1]] : [];
	const persist = argv.includes('--persist-to') ? ['--persist-to', argv[argv.indexOf('--persist-to') + 1]] : [];
	const db = config.length ? 'DB' : process.env.INBOX_D1_NAME || 'inbox';
	execFileSync(process.execPath, [wrangler, 'd1', 'execute', db, local ? '--local' : '--remote', ...config, ...persist, '--command', sql], {
		stdio: ['ignore', 'ignore', 'inherit']
	});
}
