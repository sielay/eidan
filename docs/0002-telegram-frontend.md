<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0002 — Telegram frontend (inbound chat surface)

Status: **Shipped** — `@eidandev/frontend-telegram` (`packages/frontend-telegram/`).

## Goal

Let an operator talk to their eidan from Telegram — the same agent, the same Postgres
memory, reachable from a phone without opening the web app. An inbound message becomes a
matbot turn (`run.open`) exactly like the web chat does; the reply is sent back to the chat
on completion. It is a second **frontend** over the one engine, not a separate bot.

## How it works

- **Transport: long-poll `getUpdates`.** No public ingress, no webhook, no inbound port —
  the plugin polls `https://api.telegram.org/bot<token>/getUpdates` (30s server-side hold)
  and tracks the acknowledged `update_id + 1` for idempotency. Works behind NAT / on a Pi.
  A webhook transport can be added later behind the same allowlist + run path; the admission
  and run logic live in pure modules (`allowlist.ts`, `bot.ts`) precisely so a second
  transport can reuse them.
- **Each chat = one session.** The plugin persists one session id per chat in the plugin
  settings store under the key `chat_session:<chat_id>`, creating a new session the first
  time a chat is seen. So a chat keeps its conversation history across messages.
- **Replies go out over the raw Bot API** (`sendMessage`, with `sendChatAction: typing`
  while the turn runs). Long replies are split at word/line boundaries to respect Telegram's
  4096-unit message limit. This is **inbound-only**: it does *not* use `@eidandev/notify`
  (that plugin is the separate outbound/topic-routed path).

## Auth — allowlist → principal

Telegram messages are human-sourced, so every admitted sender maps to a `{ type: 'user' }`
principal. Admission is **allowlist-only**:

1. Prefer the sender's `from.id`; fall back to the `chat.id` if the user id isn't listed
   (so a per-user mapping overrides a per-chat one).
2. An empty/absent allowlist admits **nobody** — the plugin is safe-by-default.
3. The resolved principal is established with `runAs(principal, …)` at dispatch entry so
   settings/session access is correctly scoped; the matbot runner re-scopes the turn itself.

## Enabling it

Add the plugin to `matbot.yaml` and supply two vault secrets (a third is optional):

```yaml
plugins:
  - ./packages/frontend-telegram   # inbound Telegram chat surface (long-poll getUpdates -> turn)
```

| Vault key | Required | Meaning |
|---|---|---|
| `${EIDAN_TELEGRAM_BOT_TOKEN}` | **yes** — plugin is inert without it | BotFather token. |
| `${EIDAN_TELEGRAM_ALLOWLIST}` | recommended (empty ⇒ admits nobody) | JSON object `{ "<telegram_id>": "<eidan_principal_id>", … }` mapping each allowed Telegram user (or chat) id to the eidan principal it speaks as. |
| `${EIDAN_TELEGRAM_PROVIDER}` | optional | LLM provider name (a `matbot.yaml` `providers:` key) for Telegram turns. Defaults to the first registered provider. |

These are resolved from the per-user vault at startup (`services.vault.resolve`), never from
tracked config. To find your own Telegram id, message `@userinfobot` (or any id-echo bot).

## Setup checklist

1. Create a bot with `@BotFather`, copy the token.
2. Seal it into the vault as `EIDAN_TELEGRAM_BOT_TOKEN`.
3. Seal an allowlist JSON as `EIDAN_TELEGRAM_ALLOWLIST` mapping your Telegram id → your
   eidan principal id (so your Telegram messages share your web-app memory).
4. Add `./packages/frontend-telegram` to `matbot.yaml` and restart the engine.
5. Message the bot — it should reply from the same agent as the web app.

## Not owned by this plugin

No `plugin_telegram` schema, no migrations. Conversation history rides on the core
`eidan.conversations`/`messages` tables via the matbot session store; the only plugin state
is the per-chat session-id pointer in the settings store.

## Files of record

- `packages/frontend-telegram/src/index.ts` — plugin entry, dispatch, session mapping.
- `packages/frontend-telegram/src/allowlist.ts` — `resolvePrincipal` admission logic.
- `packages/frontend-telegram/src/bot.ts` — `getUpdates` poll + `sendMessage`/`sendChatAction`.
