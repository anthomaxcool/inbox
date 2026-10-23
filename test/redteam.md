# Red-team regression tests

Phase 0 red-team: 2026-10-23, about 2 hours, by an agent that didn't build the skeleton (NEX-41, `redteam` document). It tried to get any email out of the mailbox's domain without the owner tapping Send. Every attempt through the code was refused. This file maps each logged attack to the test that keeps it refused.

| Log entry | Attack | Test |
|---|---|---|
| SD7 | Draft with `to`, `cc`, `bcc`, `reply_to`, `headers.Bcc` or `from` | `redteam/agent-api.test.ts` "SD7": 400, logged, no draft row |
| SD7 | Hostile inbound subject with CRLF and a `Bcc:` line | `redteam/owner-app.test.ts` "SD7": one recipient, subject has no CR/LF, only the 3 threading headers |
| §8.1 / §8.6 | `GET /v1/send`, `POST /v1/send`, `POST /api/drafts/x/send` and `POST /v1/threads/{id}/send` on the agent host | `redteam/agent-api.test.ts` "§8.1 / §8.6": 404 |
| §8.6 | `DELETE /v1/threads/{id}`, missing key, wrong key | `redteam/agent-api.test.ts`: 405, 401, 401 |
| Input handling | `{}`, non-JSON body, unknown thread id | `redteam/agent-api.test.ts`: 400, 400, 404 |
| SD6 | Agent rewrites the draft while it's sending, or after the owner edited it | `redteam/agent-api.test.ts` "SD6": 409, 423, current revision unchanged |
| SD4 | Support-agent bearer on owner send and read routes | `redteam/owner-app.test.ts` "SD4": 401, logged, send never called |
| SD4 | Access service-token JWT | `redteam/owner-app.test.ts` "SD4": 403, send never called |
| SD3 | Preview URLs, `workers_dev`, a named `env`, a `send_email` binding | `redteam/config.test.ts`: each one turns `check:config` red |
| §8.8 | CI workflow that reads a secret, runs `wrangler deploy`, or gets `contents: write` | `redteam/config.test.ts`: each one turns `check:config` red |

Related tests that already covered the same ground before the red-team: `app/guard.test.ts` (16 refusal cases), `app/send.test.ts` (§8.3 to §8.5), `mail/agent-api.test.ts`, `node/invariants.test.ts`.

## Not automatable here

These findings live outside the repo, so a test in this repo can't hold them. They're checked by hand at each red-team.

- **Access in front of `inbox-app`.** Live, every owner route answers 302 to the Access login before the Worker runs, even with a support bearer. This needs the deployed Access app, so it's checked live.
- **Preview or version URLs in the account.** The config can't create them (see SD3), but the owner confirms in the dashboard that none exist.
- **Send-capable credentials on the agent host** (SD1, §8.9). Any provider key in a file on the host can send without Inbox. The agent host must hold none.
- **A GitHub credential that can reach `main`** (§8.8). Only a merge to `main` deploys. The `main` ruleset (PR required, no force-push, no deletion, empty bypass list) stops a push. A credential that can merge PRs or edit rules must not be on the agent host.
