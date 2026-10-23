import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Task 0.17: the deploy-path attacks from the Phase 0 red-team (NEX-41 `redteam` log, SD3 and §8.8).
// Each test applies one attack to a copy of the repo's config and checks that the CI guard
// turns red. The unmodified copy must stay green, so a red result means the guard caught it.

const COPY = ['package.json', 'vite.config.ts', 'scripts', '.github', 'src/mail/wrangler.template.jsonc', 'src/app/wrangler.template.jsonc'];
let dir: string;

function copyRepo() {
	dir = mkdtempSync(path.join(tmpdir(), 'inbox-redteam-'));
	for (const p of COPY) cpSync(p, path.join(dir, p), { recursive: true });
	return dir;
}

function guard(script: 'check-config') {
	try {
		execFileSync('node', [`scripts/${script}.mjs`], { cwd: dir, stdio: 'pipe' });
		return 'green';
	} catch {
		return 'red';
	}
}

function edit(file: string, change: (text: string) => string) {
	const p = path.join(dir, file);
	const before = readFileSync(p, 'utf8');
	const after = change(before);
	expect(after, `attack did not apply to ${file}`).not.toBe(before);
	writeFileSync(p, after);
}

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('red-team SD3: no preview or branch build can send', () => {
	it('the unmodified copy passes check:config', () => {
		copyRepo();
		expect(guard('check-config')).toBe('green');
	});

	const attacks: [string, string, (t: string) => string][] = [
		['turns on preview URLs', 'src/app/wrangler.template.jsonc', (t) => t.replace('"preview_urls": false', '"preview_urls": true')],
		['turns on workers.dev', 'src/app/wrangler.template.jsonc', (t) => t.replace('"workers_dev": false', '"workers_dev": true')],
		['adds a named environment', 'src/app/wrangler.template.jsonc', (t) => t.replace('"workers_dev": false,', '"workers_dev": false,\n\t"env": { "staging": {} },')],
		['adds a send_email binding to inbox-mail', 'src/mail/wrangler.template.jsonc', (t) => t.replace('"workers_dev": false,', '"workers_dev": false,\n\t"send_email": [{ "name": "MAIL" }],')]
	];

	for (const [name, file, change] of attacks) {
		it(`check:config turns red when an agent ${name}`, () => {
			copyRepo();
			edit(file, change);
			expect(guard('check-config')).toBe('red');
		});
	}
});

describe('red-team §8.8: CI cannot become a deploy or a secret reader', () => {
	const attacks: [string, (t: string) => string][] = [
		['reads a secret', (t) => t.replace('- run: pnpm install --frozen-lockfile', '- run: pnpm install --frozen-lockfile\n        env:\n          TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}')],
		['runs wrangler deploy', (t) => t.replace('- run: pnpm install --frozen-lockfile', '- run: pnpm install --frozen-lockfile\n      - run: pnpm exec wrangler deploy')],
		['widens its token permissions', (t) => t.replace('contents: read', 'contents: write')]
	];

	for (const [name, change] of attacks) {
		it(`check:config turns red when a workflow ${name}`, () => {
			copyRepo();
			edit('.github/workflows/ci.yml', change);
			expect(guard('check-config')).toBe('red');
		});
	}
});
