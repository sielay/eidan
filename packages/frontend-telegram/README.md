# @eidandev/frontend-telegram

The **inbound Telegram chat surface** — an admitted sender's message becomes an
eidan `Principal`, a per-chat session is opened, and the turn runs through the
**same** matbot `run.open` path the AG-UI HTTP surface uses; the assistant's
reply is sent back to the chat. Admission is potem-style **account linking**:
`/start` → a one-time web link → sign-in binds the chat to an eidan user.

It registers a frontend, a service, and one agent tool.

## Exposes

- **Inbound long-poll loop** — `getUpdates` against the Bot API; `/start` mints
  a link token and replies with the sign-in URL, other messages from a bound
  (or allowlisted) sender run as a turn. Exactly one node may poll a bot (a
  second `getUpdates` → HTTP 409); the poller is chosen by config.
- **`/api/me/telegram/link`** — the link-redemption endpoint, served on an
  internal port and exposed via `@eidandev/frontend-agui`'s `PanelProxy`. The
  signed-in web user POSTs their one-time token; their `Principal` (from the
  `WebPrincipalResolver`) is bound to the captured chat.
- **`TelegramChats` service** — `getChatId(userId)` / `sendToUser(userId, text)`
  for outbound delivery by other plugins without holding the bot token.
- **`telegram_send` tool** — "message a bound eidan user on Telegram" (defaults
  to the current user); resolves the chat from the binding so no chat id is
  needed. (`@eidandev/notify`'s `send_message` stays for raw chat ids / Slack.)

## How consumed

Bound users chat with the bot directly; their messages run as full turns and
replies stream back (split at 4096 chars, with a typing indicator). Other
plugins (e.g. routines) deliver to a user via `services.TelegramChats?.sendToUser`.
The web app redeems the `/start` token by POSTing to the link endpoint.

## Example

User sends `/start` to the bot → bot replies with `EIDAN_WEB_URL/telegram/link?token=…`
→ user opens it, signs in → the chat is bound to their eidan account → from then
on every message they send runs as a turn under their `Principal`.

## Layout

- `src/index.ts` — the `MatbotPluginSpec`; token/provider resolve, poll loop, `/start`, message handling, service + tool registration.
- `src/link-server.ts` — the `/api/me/telegram/link` redemption endpoint (auth via `WebPrincipalResolver`).
- `src/store.ts` — `TelegramStore`: link tokens + the chat↔user binding (explicit ids, no RLS predicate).
- `src/bot.ts` — minimal Bot API client (`getUpdates`/`sendMessage`/`sendChatAction`, message splitting).
- `src/allowlist.ts` — static fallback admission (`telegram id → principal id`), default-deny.
- `src/tools.ts` — the `telegram_send` tool. `src/db.ts` — plain pooled pg access.

## Schema

`eidan.telegram_chats` (the chat↔user binding) and `eidan.telegram_link_tokens`
(one-time `/start` tokens, 30-minute expiry). Applied by the core migrate runner.

## Config

- `EIDAN_TELEGRAM_BOT_TOKEN` (vault `${EIDAN_TELEGRAM_BOT_TOKEN}`, then env, then `TELEGRAM_BOT_TOKEN`) — BotFather token. **Absent ⇒ inbound Telegram disabled.**
- `EIDAN_DATABASE_URL` (or `DATABASE_URL`) — Postgres connection (required).
- `EIDAN_WEB_URL` — web app base URL for the `/start` link (linking is off without it).
- `EIDAN_TELEGRAM_PROVIDER` — turn provider (falls back to the first registered provider).
- `EIDAN_TELEGRAM_ALLOWLIST` — optional JSON `{ "<telegram_id>": "<principal_id>" }` static fallback.
- `EIDAN_TELEGRAM_POLL=false` — disable inbound polling on this node (link + outbound only).
- `MATBOT_TELEGRAM_LINK_PORT` — internal link-server port (default `8096`).
