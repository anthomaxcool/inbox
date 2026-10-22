#!/usr/bin/env node
// Plan §8.7, §8.8, §8.12: no preview or branch deploy can send, CI holds no secrets, and the
// deployed build never uses the e2e test doubles.
import { readdirSync, readFileSync } from 'node:fs';
import { parseJsonc } from './jsonc.mjs';

const failures = [];
const fail = (msg) => failures.push(msg);

for (const worker of ['mail', 'app']) {
	const path = `src/${worker}/wrangler.template.jsonc`;
	const config = parseJsonc(readFileSync(path, 'utf8'));
	if (config.workers_dev !== false) fail(`${path}: workers_dev must be false`);
	if (config.preview_urls !== false) fail(`${path}: preview_urls must be false`);
	if ('env' in config) fail(`${path}: no "env" blocks (a named environment could turn previews back on)`);
	if ('send_email' in config) fail(`${path}: no send_email binding`);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const deployApp = pkg.scripts['deploy:app'] ?? '';
if (!/&& vite build &&/.test(deployApp) || /--config|e2e/.test(deployApp)) fail('package.json: deploy:app must build with the default vite.config.ts');
if (/test\/e2e|deps\.e2e|resolveId|E2E_JWKS/.test(readFileSync('vite.config.ts', 'utf8'))) fail('vite.config.ts: must not reference the e2e doubles');

for (const file of readdirSync('.github/workflows')) {
	const text = readFileSync(`.github/workflows/${file}`, 'utf8');
	if (/secrets\./.test(text)) fail(`.github/workflows/${file}: CI must not read secrets (plan §8.8)`);
	if (/wrangler\s+(deploy|versions|secret|d1\s+.*--remote)/.test(text)) fail(`.github/workflows/${file}: CI must not deploy`);
	if (!/permissions:\s*\n\s+contents:\s*read/.test(text)) fail(`.github/workflows/${file}: set permissions: contents: read`);
}

if (failures.length) {
	console.error('check:config FAILED:');
	for (const f of failures) console.error(`  ${f}`);
	process.exit(1);
}
console.log('check:config ok');
