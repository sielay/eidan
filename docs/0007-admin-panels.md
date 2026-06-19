<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0007 — Admin cursor panels (operator-declarable)

Status: **Shipped** — `apps/web` admin dashboard + `EIDAN_ADMIN_PANELS`.

## Goal

Surface a plugin's **managed-item loop** in the admin dashboard — a "cursor panel" listing the items
a background loop is working (e.g. the Sage coding loop's open PRs/issues, each with status, findings
and an iteration timeline). Core must stay **plugin-agnostic**: it names no bundle in tracked source.

## How it works (plugin-agnostic by construction)

1. **The operator declares panels** via the gitignored env `EIDAN_ADMIN_PANELS` — a comma list of
   `name=prefix` (or a bare `/prefix`, whose name is its last path segment):

   ```
   EIDAN_ADMIN_PANELS="sage=/api/sage, business=/api/charles"
   ```

   `GET /api/admin/panels` (Bearer-auth) returns the parsed `{ plugin, prefix }[]` — that's the only
   place the prefixes live; core source mentions no plugin.

2. **The UI probes each prefix** for the convention and **silently drops** any that don't implement
   it (so a stale entry is harmless):
   - `GET <prefix>/cursors` → `{ cursors: CursorItem[] }`
   - `GET <prefix>/summary` → `ProviderSummary`

   These reach the plugin's own HTTP server through the AG-UI front door (`PanelProxy`), the same way
   `/api/me/secrets` and `/api/me/telegram/link` do.

## The plugin contract — `CursorItem`

```ts
interface CursorItem {
  id: string;
  title: string;
  url: string | null;          // deep-link to the item (PR/issue/…)
  status: string;              // free-form; the UI maps it to a colour "zone"
  paused: boolean;
  node_id: string | null;      // which node owns this cursor
  detail: Record<string, unknown>; // generic bag — `findings` + `timeline` get a rich view
  actions: string[];           // state-appropriate verbs the UI renders as buttons (e.g. ["pause"])
}
```

- **Status → zone.** The UI maps `status` to one of `neutral | info | warn | alert | good`; an
  unknown status falls back to `neutral`, so a plugin with novel states still renders sensibly.
- **Detail bag.** `detail.findings` (severity-tagged) and `detail.timeline` (iteration entries) get a
  structured detail view; anything else is shown generically.
- **Actions.** Each verb in `actions` becomes a button; the plugin handles the corresponding call
  behind its prefix.

## Why this shape

The admin UI ships in open core but must not hard-code any specific plugin. By making the panel set
an operator-supplied env (gitignored) and the data a duck-typed convention the UI probes, a plugin
lights up its panel purely by implementing `cursors`/`summary` behind its prefix — **no edit to
core**. Same discipline as the [gitignored-config policy](../CLAUDE.md).

## Files of record

- `apps/web/src/app/api/admin/panels/route.ts` — `EIDAN_ADMIN_PANELS` parser + panels endpoint.
- `apps/web/src/components/admin/CursorsPane.tsx` — the panel UI (zones, findings, timeline).
- `apps/web/src/lib/api/admin.ts` — `CursorItem`/`CursorPanel`/`ProviderSummary` + `getPanelCursors`/
  `getPanelSummary`.
