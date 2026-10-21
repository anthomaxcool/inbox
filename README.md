# Inbox

A single-user support inbox on Cloudflare Workers where AI agents write reply drafts and only you can send. Mail to your address is stored, threaded and forwarded to you as a safety copy. Agents read threads and write a draft body through a small API with a per-agent key. A reply leaves only when you open the draft in the app, behind Cloudflare Access, and tap **Send** on the exact revision on your screen.

There is no send endpoint an agent can reach. Two Workers split the job: `inbox-mail` receives mail and serves the agent API, and has no send credential or send code. `inbox-app` serves your screens and holds the only send key, in `src/app/send.ts`. `AGENTS.md` lists the invariants that keep it that way and the test that guards each one. Setup steps are in `docs/setup.md`.
