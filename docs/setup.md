# Setup

How to run your own Inbox on your Cloudflare account. Every step a person does starts with **HUMAN:**. Nothing here holds an instance value. Where you see `<your-domain>` or similar, use your own.

**Before you start:** a Cloudflare zone for your mail domain with Email Routing on, a Cloudflare Access app in front of the app host (one-time PIN, your email only, no service-token policy), and a Resend account. Two hostnames on that zone: one for the app (behind Access) and one for the agent API (not behind Access).

## 1. Database, storage and the two Workers (P4)

1. **HUMAN:** In the Cloudflare dashboard, open **Storage & databases → D1 SQL database → Create database**. Name it `inbox` and click **Create**. On the database page, copy the **Database ID**. You'll paste it once, in step 4, and nowhere else.
2. **HUMAN:** Open **R2 object storage → Create bucket**. Pick a name, leave the location on **Automatic**, and click **Create bucket**. Note the name.
3. **HUMAN:** Open **Workers & Pages → Create → Import a repository**, connect GitHub, and pick this repository. Set:
   - **Project name:** `inbox-mail`
   - **Build command:** leave empty
   - **Deploy command:** `pnpm deploy:mail`
   - **Root directory:** `/`
4. **HUMAN:** Still on that screen, open **Advanced settings → Build variables** and add these five (plain text, not secret). Hostnames are bare: no `https://`, no trailing `/`.
   - `INBOX_D1_ID`: the Database ID from step 1
   - `INBOX_R2_BUCKET`: the bucket name from step 2
   - `APP_HOST`: the app hostname, for example `inbox.<your-domain>`
   - `AGENT_HOST`: the agent API hostname, for example `inbox-agents.<your-domain>`
   - `MAILBOX`: the address that receives support mail, for example `support@<your-domain>`

   Click **Deploy**.
5. **HUMAN:** Repeat steps 3 and 4 for the second Worker, with **Project name** `inbox-app` and **Deploy command** `pnpm deploy:app`, and the same five build variables.
6. **HUMAN:** For each Worker, open **Settings → Build → Branch control**. Set the production branch to `main`, and turn **Builds for non-production branches** off.
7. **HUMAN:** If a deploy log stops at `d1 migrations apply` with an authentication error, open **Settings → Build → API token** for that Worker and give the token **D1: Edit**, then click **Retry build**.
8. **HUMAN:** Open **inbox-app → Settings → Variables and secrets → Add**. Choose type **Secret** each time, and add:
   - `OWNER_EMAIL`: the email you sign in to Access with
   - `ACCESS_TEAM_DOMAIN`: your Zero Trust team domain as a bare hostname, for example `<team>.cloudflareaccess.com` (no `https://`, no trailing `/`)
   - `ACCESS_AUD`: the Access app's **Application Audience (AUD) tag** (Zero Trust → Access → Applications → your app → Overview)
9. **HUMAN:** Open **inbox-mail → Settings → Variables and secrets → Add**, type **Secret**, name `FORWARD_TO`, value: the personal address that gets a safety copy of every mail.
10. **HUMAN:** For each Worker, open **Settings → Domains & Routes**. Check that **workers.dev** and **Preview URLs** both say **Disabled**, and that the only route is the custom domain from step 4.

## 2. Sending (P5)

Do this only after every other Resend key that could send as this domain has been revoked or scoped to another domain.

1. **HUMAN:** In Resend, open **Domains → Add domain**, enter your mail domain, and pick a region. Add the DNS records Resend shows to the zone in Cloudflare (Resend can add them for you with **Auto configure**), then click **Verify DNS records** and wait for **Verified**.
2. **HUMAN:** Open **API keys → Create API key**. Set **Permission** to **Sending access** and **Domain** to that one domain. Click **Add**, copy the key, and paste it straight into **inbox-app → Settings → Variables and secrets → Add**, type **Secret**, name `RESEND_API_KEY`. Don't store it anywhere else.

## 3. Receiving (P6)

1. **HUMAN:** In Cloudflare, open your zone → **Email → Email Routing → Destination addresses → Add destination address**. Enter the personal address from section 1 step 9, then click the verification link Cloudflare emails to it.
2. **HUMAN:** Open **Routing rules → Custom addresses → Create address**. Enter the local part of `MAILBOX`, set **Action** to **Send to a Worker** and **Destination** to `inbox-mail`, then click **Save**.

## 4. An agent key (P8)

1. **HUMAN:** On your own computer (not a machine agents run on), run `npx wrangler login`, then in a clone of this repository run `pnpm install` and `pnpm key:create support-agent`. The key prints once.
2. **HUMAN:** Store the key straight into the agent's secret store (for Paperclip: **Company → Secrets → New secret**, then grant it to the agents that draft replies). Close the terminal.
3. To revoke it later: `pnpm key:revoke support-agent`. It fails on the agent's next request.

## Check

- `https://<APP_HOST>` shows the Access sign-in page.
- `GET https://<AGENT_HOST>/v1/threads` with header `Authorization: Bearer <the key>` returns `200` and `{"threads":[]}`.
- There is no send endpoint for the key. Any attempt by the agent to send must fail.
