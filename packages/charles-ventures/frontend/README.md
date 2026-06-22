# ventures — bundle frontend (Charles · Ventures screen)

The deterministic **Ventures** dashboard (Surface B), recreating the
Claude Design mock (`Charles Review.html` → `VenturesFull`) against the
core design system. This is the **UI half** of the `ventures` plugin; the
agent-tools half is in `../src`.

## What's here

| File | Role |
|------|------|
| `Ventures.tsx`  | The screen (default export). Venture profile + `ScopeSwitcher` (holding-tree scope control) + linked resources + other ventures, a responsive **identity context panel** (desktop aside / mobile card) with a Companies House lookup affordance, and the **attach-resource bottom sheet**. Live / loading / empty / error states. |
| `api/route.ts`  | `GET /api/charles/ventures[?venture=<id>]` (list + current incl. identity + resources) and `POST` (attach a resource) — the deterministic data route over `plugin_ventures.*` (Next-reads-Postgres, owner-scoped). Shipped here because the schema is bundle-private. |
| `api/create.ts` | `POST /api/charles/ventures/create` — create a venture (mirrors the `ventures_create` tool); the write behind the "Add venture" sheet. |
| `api/lookup.ts` | `POST /api/charles/ventures/lookup` — the ⚡ hybrid Companies House lookup (mirrors the `venture_lookup_company` tool), folds the official record into `metadata.identity`. Self-contained. |
| `charles.css`   | Only the screen-specific classes **not** already in core `globals.css` (scope-menu internals, `.res-row`, the responsive `.ven-layout`/identity panel, the bottom-sheet overlay). Authored against the same tokens — one design system. |

It reuses core's design system: tokens + `.card/.stat/.pill/.loglist/.scope/.grid-2/.empty/.screen-sub`, and the `authFetch` / `@/server/*` helpers — all resolve once the package is assembled into `apps/web`.

## The contract (`package.json` → `eidan.frontend`)

A bundle plugin contributes UI by declaring a frontend manifest:

```jsonc
"eidan": { "frontend": {
  "package": "frontend",                 // dir copied into apps/web/src/plugins/<plugin>/
  "stylesheet": "charles.css",           // imported globally
  "routes": [{ "path": "/", "component": "Ventures.tsx" }],   // → /p/<plugin>/<path>
  "api":    [{ "path": "/api/charles/ventures", "handler": "api/route.ts" }],
  "nav":    { "group": "Charles · business", "sections": [ /* NavSection[] */ ] }
}}
```

The host side already exists in core (`@/plugins/registry.generated`,
`PluginSlot`, `PluginRouteRenderer`, `/p/[plugin]/[[...slug]]`, the
`NavContribution` model). **The build-context assembly that reads this
manifest — copies `package` into `apps/web/src/plugins/<plugin>/`,
generates `registry.generated.ts` (routes + slots), mounts `api[]`
handlers, and merges `nav` into the shell — was not yet ported into the
matbot-era `deploy/assemble.mjs`** (the Python `assemble_plugin_frontends`
from eidan#284 is the reference). That generator is the one core piece
this screen depends on to mount.
