import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { checkLabel, createKeySql, makeKey, revokeKeySql } from '../../scripts/keys-sql.mjs';

// pnpm key:create / key:revoke generate this SQL. A created key works; a revoked one fails next request.
describe('key scripts', () => {
	it('creates a working key, stores only its hash, and revokes it', async () => {
		const key: string = makeKey();
		expect(key).toMatch(/^ibx_[A-Za-z0-9_-]{43}$/);
		await env.DB.prepare(await createKeySql('support-agent', key)).run();
		const row = await env.DB.prepare("SELECT key_hash FROM agent_keys WHERE label = 'support-agent'").first<{ key_hash: string }>();
		expect(row!.key_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(row!.key_hash).not.toContain(key.slice(4));

		const list = () => SELF.fetch('https://agents.example.com/v1/threads', { headers: { Authorization: `Bearer ${key}` } });
		expect((await list()).status).toBe(200);
		expect(await (await list()).json()).toEqual({ threads: [] });

		await env.DB.prepare(revokeKeySql('support-agent')).run();
		expect((await list()).status).toBe(401);
	});

	it('rejects labels that could inject SQL', () => {
		for (const bad of ["x'; DROP TABLE agent_keys; --", 'UPPER', '', 'a', 'has space']) expect(() => checkLabel(bad)).toThrow();
	});
});
