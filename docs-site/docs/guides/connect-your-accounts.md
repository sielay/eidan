---
id: connect-your-accounts
title: Connect your accounts
---

# Connect your accounts

eidan works over **your own** email, calendar, files, and services — read-through, so nothing is
synced-and-hoarded. Credentials live in a per-user encrypted vault and are used **by reference**: the
agent can act with them, but never sees the values and they're never pasted into a prompt.

## The vault first

Add a credential once, from the Settings UI or the LLM-free secrets API, and it's sealed at rest
(envelope-encrypted; the master key stays in your environment). From then on any plugin that needs it
resolves it from the vault — including on other nodes, with no per-node env. See the
[vault concept](/concepts).

{/* TODO(screenshot): the Settings → Secrets / integrations panel where you connect an account. */}

## What you can connect (core)

| Account | What eidan does |
|---|---|
| **Mail (IMAP/SMTP)** | Read-through your inbox and send over your own account — triage, search, draft. |
| **Calendar (.ics)** | Read upcoming events and search — morning briefs, scheduling context. |
| **Gmail** | Read-through Gmail over OAuth2. |
| **Google Drive** | Search + read your files. |

## More, with bundles

Enable **Charles** (business) to connect socials (8 networks, BYO-OAuth), books (Xero/Stripe
read-through), market signals (Trends, Search Console, Trading 212), and domains — each credential
sealed in the vault the same way.

## Reach back out

Connect **Slack or Telegram** as notification targets so agents can ping you — a found signal, a
finished job, a decision it needs. Routing is by topic (`EIDAN_NOTIFY_ROUTES`).

---

Next: give an agent a job over these accounts — see [Build an agent](/guides/build-an-agent).
