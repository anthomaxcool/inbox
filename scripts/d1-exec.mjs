// Runs one SQL statement on the Inbox D1 with the owner's own wrangler login.
// The agent host has no Cloudflare login by design, so on that host only --local works.
import { execFileSync } from 'node:child_process';

export function d1Exec(sql, argv) {
	const local = argv.includes('--local');
	const config = argv.includes('-c') ? ['-c', argv[argv.indexOf('-c') + 1]] : [];
	const persist = argv.includes('--persist-to') ? ['--persist-to', argv[argv.indexOf('--persist-to') + 1]] : [];
	const db = config.length ? 'DB' : process.env.INBOX_D1_NAME || 'inbox';
	execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', db, local ? '--local' : '--remote', ...config, ...persist, '--command', sql], {
		stdio: ['ignore', 'ignore', 'inherit']
	});
}
