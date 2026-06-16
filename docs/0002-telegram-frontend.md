<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0002 — Telegram frontend (inbound chat + account linking)

Status: **Shipped** — `@eidandev/frontend-telegram` (`packages/frontend-telegram/`).

## Goal

Let an operator talk to their eidan from Telegram — the same agent, the same Postgres memory,
reachable from a phone without opening the web app. An inbound message becomes a matbot turn
(`run.open`) exactly like the web chat; the reply goes back to the chat. It's a second **frontend**
over the one engine, not a separate bot. Routines and notifications can also be **delivered** to a
linked chat (outbound), via the `TelegramChats` service.

## How it works

- **Transport: long-poll `getUpdates`.** No public ingress / webhook / inbound port — the plugin
  polls `https://api.telegram.org/bot<token>/getUpdates` (30s hold) and tracks `update_id + 1`.
  Works behind NAT / on a Pi.
- **Single poller across nodes.** Telegram allows exactly one `getUpdates` poller per bot (a second
  returns HTTP 409). Nodes are **not** auto-elected (a DB advisory lock doesn't survive a
  transaction-pooled connection), so polling is config-gated: every node serves the link endpoint +
  outbound, but only nodes with `EIDAN_TELEGRAM_POLL != "false"` run the inbound loop. Set it
  `false` on all but one node (keep the always-on node polling).
- **Each chat = one session.** One session id per chat is kept in the settings store under
  `chat_session:<chat_id>` (backed by `eidan.kv`), so a chat keeps its history.
- **Replies + outbound** go over the raw Bot API (`sendMessage`, chunked at Telegram's 4096-unit
  limit; `sendChatAction: typing` while a turn runs).

## Account linking (potem-style)

No manual chat-id entry. A Telegram chat **binds** to an eidan user through a one-time token:

1. **`/start`** → the bot captures `msg.chat.id`, mints a row in `eidan.telegram_link_tokens`, and
   replies with a web link: `${EIDAN_WEB_URL}/telegram/link?token=…` (30-min TTL).
2. The user opens the link, **signs into the eidan web app** (the `/telegram/link` page is a public
   route that renders its own sign-in prompt and returns via `?next`).
3. The page POSTs the token to `/api/me/telegram/link` — reverse-proxied through the AG-UI front door
   (`PanelProxy`) to the plugin's link server, which resolves the caller's `Principal` from the
   Bearer JWT, validates the token, and **upserts `eidan.telegram_chats(user_id, chat_id)`**. The
   bot confirms in the chat.
4. **Thereafter:** inbound messages look up `telegram_chats` by `chat_id` → the bound user is the
   principal; outbound (`TelegramChats.sendToUser`) looks up `chat_id` by `user_id`.

A static `${EIDAN_TELEGRAM_ALLOWLIST}` (JSON `{telegram_id: principal_id}`) still works as a
fallback for pre-provisioned mappings; otherwise an unbound chat is told to `/start`.

## Outbound: the `TelegramChats` service

`frontend-telegram` registers `TelegramChats` so other plugins deliver to a user's bound chat
without holding the bot token: `getChatId(userId)` and `sendToUser(userId, text)`. `@eidandev/routines`
uses it to deliver a routine's result to the owner's Telegram (in addition to the `notify` topic).

## Enabling it

```yaml
plugins:
  - ./packages/frontend-telegram   # after frontend-agui (PanelProxy) + notify + jobs
```

| Config | Required | Meaning |
|---|---|---|
| `${EIDAN_TELEGRAM_BOT_TOKEN}` (vault) / `EIDAN_TELEGRAM_BOT_TOKEN` / `TELEGRAM_BOT_TOKEN` (env) | **yes** (any one) | BotFather token. Resolved from the vault first, then plain env. |
| `EIDAN_WEB_URL` | for linking | Base URL of the web app (e.g. `https://e.sielay.com`) — used to build the `/start` link. |
| `EIDAN_TELEGRAM_POLL` | multi-node | `false` on all but one node (only one may poll a bot). |
| `${EIDAN_TELEGRAM_ALLOWLIST}` | optional | Fallback JSON `{ "<telegram_id>": "<eidan_principal_id>" }`. |
| `${EIDAN_TELEGRAM_PROVIDER}` | optional | Provider for Telegram turns; defaults to the first registered. |
| `MATBOT_TELEGRAM_LINK_PORT` | optional | Link-server loopback port (default 8096). |

Also needs `EIDAN_DATABASE_URL` (for the binding tables) and `EIDAN_WEB_URL` set on each engine node.

## Setup checklist

1. Create a bot with `@BotFather`; put the token in the vault as `EIDAN_TELEGRAM_BOT_TOKEN` (or env).
2. Set `EIDAN_WEB_URL` to your deployed web app; load `./packages/frontend-telegram` after
   `frontend-agui`; on extra nodes set `EIDAN_TELEGRAM_POLL=false`. Restart.
3. Apply migrations `0004_telegram_link.sql` (binding tables) + `0005_kv.sql` (settings store).
4. In Telegram, send **`/start`** to the bot → tap the link → sign in → done. Message it; it replies
   from the same agent as the web app, and routines arrive in the chat.

## Schema (this plugin's tables, core `eidan.*`)

- `eidan.telegram_link_tokens` — one-time `/start` tokens (chat_id, 30-min TTL, single-use).
- `eidan.telegram_chats` — the `user_id ↔ chat_id` binding (one chat per user, one user per chat).
- Session pointers live in `eidan.kv` (the matbot settings/KV store).

## Files of record

- `src/index.ts` — boot, single-poller gate, `/start`, bound-chat admission, `TelegramChats`.
- `src/store.ts` — link-token + binding store. `src/db.ts` — pooled pg access.
- `src/link-server.ts` — `/api/me/telegram/link` redemption (WebPrincipalResolver → bind).
- `src/allowlist.ts` — static-allowlist fallback. `src/bot.ts` — `getUpdates` / `sendMessage`.
- Web: `apps/web/src/app/telegram/link/page.tsx` (public redemption page).
