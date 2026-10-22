# AGENTS.md · Inbox

Read this before changing anything. Inbox exists for one guarantee: **no agent can get an email out without the owner tapping Send.** The invariants below keep that true. A change that breaks one is wrong, even if every feature works. Each one names the test that guards it, and every test runs in CI on every PR.

## Send-gate invariants (plan §8)

| § | Invariant | Guarded by |
|---|---|---|
| 8.1 | Only `src/app/send.ts` calls the provider. `inbox-mail` has no send key, no send code, no `send_email` binding, and never imports `src/app`. | `scripts/check-send-surface.mjs`, `test/node/invariants.test.ts` |
| 8.2 | Every `inbox-app` request passes `ownerGuard`: Access JWT verified here (JWKS, `aud`, `iss`, `exp`), owner email only, service-token JWTs refused, and for mutations `Origin` + JSON + `X-Inbox-Intent`. Nothing in `inbox-app` reads `Authorization`. | `test/app/guard.test.ts`, `test/node/invariants.test.ts` |
| 8.3 | Send binds to a revision: one D1 batch inserts the attempt and locks the draft only if it is `open` and its current revision is the one requested. Agent writes get 409 while `sending`. | `test/app/send.test.ts` (§8.3) |
| 8.4 | One send per idempotency key. A repeat key returns the first attempt. The key goes to the provider as `Idempotency-Key`, so retrying an unknown outcome never sends twice. | `test/app/send.test.ts` (§8.4), `test/mail/schema.test.ts` |
| 8.5 | Recipient, subject and threading headers come from the thread, never the draft. Agents send `{ body }` only. Unknown fields are a 400. | `test/app/send.test.ts` (§8.5), `test/mail/agent-api.test.ts` |
| 8.6 | Agent keys are SHA-256 hashed, work only on `inbox-mail` `/v1`, get 423 on an owner-edited draft, and fail on the next request once revoked. | `test/mail/agent-api.test.ts`, `test/mail/keys.test.ts` |
| 8.7 | `workers_dev: false` and `preview_urls: false` in both templates, with no `env` blocks. | `scripts/check-config.mjs`, `test/node/invariants.test.ts` |
| 8.8 | CI runs tests only: read-only permissions, no `secrets.*`, no deploy step. Deploy credentials live only in Workers Builds. | `scripts/check-config.mjs`, `test/node/invariants.test.ts` |
| 8.9 | No send-capable credential outside the `inbox-app` secret: no keys in the repo, ever. | `gitleaks` (pre-commit hook in `.githooks/`, full history in CI) |
| 8.10 | Notifiers are output-only: no inbound notifier route exists. (The Telegram adapter arrives in Phase 1 with its own tests.) | `test/mail/agent-api.test.ts` |
| 8.11 | Nothing from an email runs: HTML becomes text on ingest, no `{@html}` (lint rule), the exact CSP plus `noindex` and `no-referrer` on every response. | `test/mail/ingest.test.ts`, `test/e2e/review.spec.ts`, `test/node/invariants.test.ts`, `eslint.config.js` |
| 8.12 | No instance values in the repo: `wrangler.jsonc` is rendered from build variables and git-ignored. | `test/node/invariants.test.ts`, `gitleaks` |

## Running checks

```sh
pnpm install            # also points git at .githooks (gitleaks pre-commit)
pnpm test               # Vitest inside workerd: mail, app and node projects
pnpm test:e2e           # Playwright, screen 4 against wrangler dev (test doubles, local D1)
pnpm lint && pnpm check:send-surface && pnpm check:config
```

Tests use `@cloudflare/vitest-plugin`, the renamed `@cloudflare/vitest-pool-workers` the plan names.

## Never

- Never add a route, binding, secret or module to `inbox-mail` that can send, or make it import from `src/app`.
- Never accept recipients, subject or headers from an agent, and never store them on a draft.
- Never put a key, address, account ID, D1 ID or bucket name in the repo, a commit message or an issue.
- Never deploy from CI, and never build the deploy artifact with `vite.e2e.config.ts`.
- Never run a remote `wrangler` command from an agent host. The owner runs `pnpm key:create` and `pnpm key:revoke`.
