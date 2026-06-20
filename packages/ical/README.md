# @eidandev/ical

The **calendar** integration — read-through `.ics` / CalDAV feed reading
over the operator's own named calendars. A matbot plugin (part of the
eidan-pro baseline bundle): it registers the two calendar tools below plus
an ambient system-context contribution, over the `plugin_ical.*` schema.

Connection model: each calendar (a name, an agent-facing context note, and
the `.ics`/CalDAV URL) is managed in the **Calendars** screen (the plugin's
frontend manifest). The registry rows live in `plugin_ical.calendars`; the
feed URL itself is **sealed in the vault** (`eidan.secrets_vault`) under the
calendar's `vault_key`, never in plain columns. Nothing is synced or
stored — feeds are fetched and parsed live per call (via `node-ical`, which
expands recurring events through their RRULE within the requested window).
A legacy single `EIDAN_ICAL_FEED_URLS` secret is honoured when no calendar
is registered.

## Tools

| Tool | Purpose |
|------|---------|
| `calendar_upcoming` | List upcoming events across all named calendars within the next N `days` (default 14). Each event carries its `calendar` name + `context`; the result also includes the operator's `routine`. |
| `calendar_search`   | Find events whose title matches `query`, across all calendars, past and future. Each hit carries its `calendar` name + `context`. |

## Example

> **You:** What's on my calendar this week?
>
> → the agent calls `calendar_upcoming({ days: 7 })` — eidan lists the
> caller's calendars, resolves each URL from the vault, fetches the feeds,
> and returns events tagged by calendar (times already rendered as local
> wall-clock in the operator's timezone).

## Layout

- `src/index.ts` — the `MatbotPluginSpec`; builds `Db` from `EIDAN_DATABASE_URL`, registers the tools, and contributes ambient `systemContext` (the operator's timezone + today + routine, every turn).
- `src/tools.ts` — the matbot `Tool[]`; resolves the caller's calendars (vault URLs), gathers + tags + sorts events, renders times in the operator's zone.
- `src/ics.ts` — `.ics` fetching + parsing with `node-ical` RRULE expansion (injectable fetcher for tests).
- `src/db.ts` — owns `plugin_ical.*`; principal-stamped query helper; `ensureSchema` (idempotent, self-creating on first boot).

## Schema

`plugin_ical.calendars` (per-user registry: name, slug, context, `vault_key`)
and `plugin_ical.settings` (per-user `routine` note + IANA `timezone`).
Created idempotently by the plugin on first boot (mirrored in the tracked
`migrations/` SQL for the migrate runner).

## Config

- `EIDAN_DATABASE_URL` (or `DATABASE_URL`) — Postgres connection (**required**; the plugin owns the `plugin_ical` registry).
- `EIDAN_ICAL_FEED_URLS` — legacy single-calendar fallback (comma/space-joined feed URLs), used only when no calendar is registered.
