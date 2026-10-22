import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { render } from '../../scripts/render-wrangler.mjs';
import { SECURITY_HEADERS } from '../../src/app/lib/server/headers';

// Source-level invariants from plan §8 that are cheapest to check by reading the code.

// Files in the repo (tracked, or new and not ignored), so build output never counts.
const repoFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
	.split('\n')
	.filter((f) => f && existsSync(f));
const source = (dir: string) => repoFiles.filter((f) => f.startsWith(`${dir}/`) && /\.(ts|js|mjs|svelte)$/.test(f));

describe('plan §8 invariants', () => {
	it('§8.1 check:send-surface passes: only src/app/send.ts can send', () => {
		expect(() => execFileSync('node', ['scripts/check-send-surface.mjs'], { stdio: 'pipe' })).not.toThrow();
	});

	it('§8.7 check:config passes: no workers_dev, no preview URLs, CI reads no secrets', () => {
		expect(() => execFileSync('node', ['scripts/check-config.mjs'], { stdio: 'pipe' })).not.toThrow();
	});

	it('§7 draft_revisions is append-only: no UPDATE or DELETE on it anywhere in the code', () => {
		for (const file of [...source('src'), ...source('scripts')]) {
			expect(readFileSync(file, 'utf8'), file).not.toMatch(/(UPDATE|DELETE\s+FROM)\s+draft_revisions/i);
		}
	});

	it('§8.2 no inbox-app code reads an Authorization header', () => {
		for (const file of source('src/app')) {
			expect(readFileSync(file, 'utf8'), file).not.toMatch(/get\(\s*['"]authorization['"]\s*\)/i);
		}
	});

	it('§8.1 only the owner deps import the send module at runtime (tests aside)', () => {
		const importers = [...source('src'), ...source('test')].filter((f) => /^import\s+(?!type\b)[^;]*from\s+['"][^'"]*\/send['"]/m.test(readFileSync(f, 'utf8')));
		expect(importers.filter((f) => !f.startsWith('test/')).sort()).toEqual(['src/app/lib/server/deps.ts']);
	});

	it('§8.11 _headers for static assets matches the Worker headers exactly', () => {
		const lines = readFileSync('_headers', 'utf8').split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
		expect(Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]))).toEqual(SECURITY_HEADERS);
	});

	it('§8.11 no {@html} anywhere in Svelte files', () => {
		for (const file of source('src').filter((f) => f.endsWith('.svelte'))) expect(readFileSync(file, 'utf8'), file).not.toContain('{@html');
	});

	it('§8.12 the wrangler templates render only from build variables, and refuse when one is missing', () => {
		const vars = {
			INBOX_D1_ID: 'e2e00000-0000-4000-8000-00000000e2e0',
			INBOX_R2_BUCKET: 'inbox-raw',
			APP_HOST: 'inbox.example.com',
			AGENT_HOST: 'inbox-agents.example.com',
			MAILBOX: 'support@example.com'
		};
		for (const worker of ['mail', 'app']) {
			const template = readFileSync(`src/${worker}/wrangler.template.jsonc`, 'utf8');
			const out: string = render(template, vars);
			expect(out).not.toMatch(/\$\{/);
			expect(() => render(template, { ...vars, INBOX_D1_ID: '' })).toThrow(/missing build variable INBOX_D1_ID/);
			expect(() => render(template, { ...vars, MAILBOX: 'x"},"workers_dev":true,"y":{"a":"b' })).toThrow(/unexpected format/);
		}
	});

	it('§8.12 rendered wrangler.jsonc files are git-ignored', () => {
		expect(execFileSync('git', ['check-ignore', 'src/app/wrangler.jsonc', 'src/mail/wrangler.jsonc'], { encoding: 'utf8' })).toContain('src/app/wrangler.jsonc');
	});
});
