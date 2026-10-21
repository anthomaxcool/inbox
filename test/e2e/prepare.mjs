#!/usr/bin/env node
// Prepares a Playwright run: fresh signing key and owner JWT, rendered config, e2e build,
// local D1 with migrations and a seeded thread + agent draft. Everything lands in .e2e-state/.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export const E2E = {
	port: 8799,
	owner: 'owner@example.net',
	team: 'team.example.com',
	aud: 'e2e-aud',
	mailbox: 'inbox-test@example.com',
	threadId: 'e2ethread00000000000000000',
	draftId: 'e2edraft000000000000000000',
	revisionId: 'e2erev00000000000000000000'
};

const state = '.e2e-state';
rmSync(state, { recursive: true, force: true });
mkdirSync(`${state}/xdg`, { recursive: true });

const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'e2e', alg: 'RS256' }] };
const jwt = await new SignJWT({ email: E2E.owner, type: 'app' })
	.setProtectedHeader({ alg: 'RS256', kid: 'e2e' })
	.setIssuer(`https://${E2E.team}`)
	.setAudience(E2E.aud)
	.setIssuedAt()
	.setExpirationTime('1h')
	.sign(privateKey);
writeFileSync(`${state}/jwt.txt`, jwt);

const env = {
	...process.env,
	// Isolate wrangler from any login on this machine: it must never touch a real account here.
	XDG_CONFIG_HOME: `${process.cwd()}/${state}/xdg`,
	WRANGLER_SEND_METRICS: 'false',
	CLOUDFLARE_API_TOKEN: '',
	INBOX_D1_ID: '00000000000000000000000000000000',
	INBOX_R2_BUCKET: 'inbox-e2e',
	APP_HOST: `localhost:${E2E.port}`,
	AGENT_HOST: 'localhost:8798',
	MAILBOX: E2E.mailbox,
	E2E_JWKS: JSON.stringify(jwks)
};
const run = (cmd, args) => execFileSync(cmd, args, { env, stdio: ['ignore', 'ignore', 'inherit'] });

run('node', ['scripts/render-wrangler.mjs', 'app']);
run('pnpm', ['exec', 'vite', 'build', '--config', 'vite.e2e.config.ts']);
run('pnpm', ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', `${state}/wrangler`, '-c', 'src/app/wrangler.jsonc']);

const now = new Date().toISOString();
const seed = `
INSERT INTO threads (id, mailbox, subject, counterparty_name, counterparty_address, reply_to, cc_seen, last_message_at, last_direction, created_at)
VALUES ('${E2E.threadId}', '${E2E.mailbox}', 'Where is my order?', 'Customer', 'customer@example.org', 'customer@example.org', '[]', '${now}', 'in', '${now}');
INSERT INTO messages (id, thread_id, mailbox, direction, message_id_hdr, from_name, from_address, "to", cc, subject, date, text_body, created_at)
VALUES ('e2emsg00000000000000000000', '${E2E.threadId}', '${E2E.mailbox}', 'in', 'order-1@mail.example.org', 'Customer', 'customer@example.org', '["${E2E.mailbox}"]', '[]', 'Where is my order?', '${now}', 'Hi, my order has not arrived. <script>alert(1)</script>', '${now}');
INSERT INTO agent_keys (id, label, key_hash, created_at) VALUES ('e2ekey00000000000000000000', 'support-agent', 'e2e-hash', '${now}');
INSERT INTO drafts (id, thread_id, status, owner_locked, current_revision_id, created_at) VALUES ('${E2E.draftId}', '${E2E.threadId}', 'open', 0, '${E2E.revisionId}', '${now}');
INSERT INTO draft_revisions (id, draft_id, n, body, body_sha256, author, agent_key_id, created_at)
VALUES ('${E2E.revisionId}', '${E2E.draftId}', 1, 'Hello, your order shipped yesterday.', 'x', 'agent:support-agent', 'e2ekey00000000000000000000', '${now}');
`;
writeFileSync(`${state}/seed.sql`, seed);
run('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', `${state}/wrangler`, '-c', 'src/app/wrangler.jsonc', '--file', `${state}/seed.sql`]);
console.log('e2e state ready');
