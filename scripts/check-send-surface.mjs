#!/usr/bin/env node
// Plan §8.1: one function sends, and it lives in a Worker agents can't reach.
// Fails if any source or config file other than src/app/send.ts mentions the provider's host,
// its key, or a `send_email` binding, or if inbox-mail can reach the app's code.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SEND_MODULE = 'src/app/send.ts';
const FORBIDDEN = [/api\.resend\.com/i, /RESEND_API_KEY/, /send_email/i, /email_sending/i];
// Not deployed code: tests (which mock the provider), prose, and this checker.
const EXEMPT = [/^test\//, /\.md$/, /^LICENSE$/, /^pnpm-lock\.yaml$/, /^scripts\/check-(send-surface|config)\.mjs$/];

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
	.split('\n')
	.filter(Boolean)
	.filter((f) => f !== SEND_MODULE && !EXEMPT.some((re) => re.test(f)));

const failures = [];
for (const file of files) {
	let text;
	try {
		text = readFileSync(file, 'utf8');
	} catch {
		continue; // deleted in the working tree
	}
	for (const re of FORBIDDEN) if (re.test(text)) failures.push(`${file}: matches ${re}`);
	// inbox-mail and shared code must never import the app (and so can never reach send.ts).
	if (/^src\/(mail|shared)\//.test(file) && /from\s+['"][^'"]*\/app\//.test(text)) failures.push(`${file}: imports from src/app`);
}

const mailTemplate = readFileSync('src/mail/wrangler.template.jsonc', 'utf8');
if (/resend/i.test(mailTemplate)) failures.push('src/mail/wrangler.template.jsonc: mentions the send provider');

if (failures.length) {
	console.error(`check:send-surface FAILED. Only ${SEND_MODULE} may send (plan §8.1):`);
	for (const f of failures) console.error(`  ${f}`);
	process.exit(1);
}
console.log(`check:send-surface ok (${files.length} files)`);
