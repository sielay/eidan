# @eidandev/imap

The **mail** integration — email as agent input *and* output: read-through
IMAP (list / search / read, read-only) plus SMTP send, over the operator's
own named mail accounts. A matbot plugin (part of the eidan-pro baseline
bundle): it registers the four tools below over the `plugin_imap.*` schema.

Connection model: the operator registers named accounts in the
**Integrations → Mail** screen (the plugin's frontend manifest). The
non-secret connection fields (IMAP/SMTP host, port, username, the SMTP
From) live in plain columns in `plugin_imap.accounts`; only the
IMAP/SMTP **passwords are sealed in the vault** (`eidan.secrets_vault`)
under each account's `imap_pass_key` / `smtp_pass_key`. Each tool takes an
optional `account` name and resolves that account's config per call.
A legacy single env account (`EIDAN_IMAP_*` / `EIDAN_SMTP_*`, declared to
the Settings → Connections catalog via `EidanSecrets`) is used as a
fallback when no account is registered. Mail is read live — nothing is
stored beyond the registry. Uses `imapflow` + `mailparser` for IMAP and
`nodemailer` for SMTP.

## Tools

| Tool | Purpose |
|------|---------|
| `imap_list_recent`  | List the most recent messages (sender, subject, date, id) in a `mailbox` (default INBOX). |
| `imap_search`       | Find messages whose text contains `query` (returns sender/subject/date/id). |
| `imap_read_message` | Read one message in full (headers + plain-text body, capped 8k) by its `uid`. |
| `mail_send`         | Send a plain-text email via SMTP (`to`, `subject`, `body`; optional `cc`). |

All tools accept an optional `account` to pick among several named accounts.

## Example

> **You:** Reply to the invoice email from Acme saying it's approved.
>
> → the agent calls `imap_search({ query: "Acme invoice" })`, then
> `imap_read_message({ uid: "..." })`, then
> `mail_send({ to: ["billing@acme.com"], subject: "Re: Invoice", body: "Approved." })`
> — each resolving the account's password from the vault per call.

## Layout

- `src/index.ts` — the `MatbotPluginSpec`; builds `Db` from `EIDAN_DATABASE_URL`, registers the tools, declares the legacy single-account section to `EidanSecrets`.
- `src/tools.ts` — the matbot `Tool[]` (list/search/read + send).
- `src/config.ts` — per-account credential resolution: registered account (password from vault) or legacy env fallback; `slugify` + pass-key derivation shared with the admin data route.
- `src/client.ts` — IMAP read client (`imapflow` + `mailparser`).
- `src/sender.ts` — SMTP send (`nodemailer`).
- `src/vault.ts` — vault `secret` / `secretOpt` helpers.
- `src/db.ts` — owns `plugin_imap.*`; principal-stamped helper; `ensureSchema` (idempotent, self-creating).

## Schema

`plugin_imap.accounts` — per-user registry: name, slug, IMAP host/port/user,
SMTP host/port/user/from, the `imap_pass_key` / `smtp_pass_key` vault refs,
and `status`. No password ever lands here. Created idempotently by the
plugin on first boot (mirrored in the tracked `migrations/` SQL).

## Config

- `EIDAN_DATABASE_URL` (or `DATABASE_URL`) — Postgres connection (**required**; the plugin owns the `plugin_imap` registry).
- `EIDAN_IMAP_HOST` / `EIDAN_IMAP_USERNAME` / `EIDAN_IMAP_PASSWORD` / `EIDAN_IMAP_PORT` (default 993) — legacy single-account IMAP fallback.
- `EIDAN_SMTP_HOST` / `EIDAN_SMTP_USERNAME` / `EIDAN_SMTP_PASSWORD` / `EIDAN_SMTP_PORT` (e.g. 587) / `EIDAN_SMTP_FROM` — legacy single-account SMTP fallback.
