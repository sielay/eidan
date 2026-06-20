# @eidandev/notify

eidan's **outbound messaging** plugin. Two surfaces over the same Slack /
Telegram senders: **topology-driven system-event routing** (a topic resolves to
a channel + target via `EIDAN_NOTIFY_ROUTES`) and a **free-form `send_message`
agent tool** (the assistant posts to any channel/chat directly). Senders are
plain `fetch` (potem's pattern, no SDK). Ported from eidan's `notify_routes.py`.

It registers the `Notify` service plus the `send_message` tool.

## Exposes

- **`Notify` service** — consumed by other plugins topic-first:
  - `emit(topic, text, severity?)` — fire-and-forget for system events; a
    missing route or webhook is a silent no-op (never throws), so a boot or a
    tick can't crash on it.
  - `deliver(topic, text)` — topic→route delivery returning a status (does not
    swallow errors).
  - `sendTo(channel, target, text)` — free-form on-demand send; the caller picks
    the channel + destination directly (no declared route needed). Backs the tool.
- **`send_message` tool** — the agent-facing counterpart of `sendTo`: it chooses
  `channel` (`slack`/`telegram`) + `target` + `text` at call time. The
  capability boundary is just whether a bot token is held for that channel; its
  description advertises which channels are available.

## Topics

A topic (e.g. `node.startup`, `job.update`, `amygdala`) maps via
`EIDAN_NOTIFY_ROUTES` to `{ channel, target }`. An unrouted topic is a no-op.
On boot the plugin itself emits `node.startup` ("eidan-matbot node started").

## How consumed

Plugins call `services.Notify?.emit('job.update', '…')` for system events. The
assistant calls `send_message` for on-demand posts ("post X to #y"). Channels:
**slack** (`chat.postMessage`, target = channel name/id) and **telegram**
(`sendMessage`, target = numeric chat id).

## Layout

- `src/index.ts` — the `MatbotPluginSpec`; loads routes + tokens, registers the `Notify` service and the `send_message` tool, emits `node.startup`.
- `src/notify.ts` — `loadRoutes`, the `Notify` interface, and `NotifyImpl` (`emit`/`deliver`/`sendTo` + the Slack/Telegram senders).
- `src/tools.ts` — the free-form `send_message` `Tool` (capability gated on configured tokens).

## Config

- `EIDAN_NOTIFY_ROUTES` — JSON `{ "<topic>": { "channel": "slack|telegram", "target": "…" } }` (optional; no routes ⇒ system topics are no-ops).
- `EIDAN_SLACK_BOT_TOKEN` — Slack bot token (enables the slack channel).
- `EIDAN_TELEGRAM_BOT_TOKEN` (or `TELEGRAM_BOT_TOKEN`) — Telegram bot token (enables the telegram channel).
- `EIDAN_NOTIFY_DRYRUN=1` — log deliveries instead of sending.
