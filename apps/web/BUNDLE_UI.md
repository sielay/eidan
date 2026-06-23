<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# How a plugin ships its own UI

A plugin (core or an opt-in bundle) can contribute **web UI** to the reference app — nav sections, full
pages, inline widgets, and its own deterministic API routes — **without editing core**. The deploy's
`assemble` step vendors it in, parallel to how engine plugins are vendored into `packages/<name>/`.

The host side already exists: `@/plugins/registry.generated` + `PluginRouteRenderer` (via the
`/p/[plugin]/[[...slug]]` catch-all) + `<PluginSlot name="…">` + the `NavContribution` model. The
piece this documents is the **assembly generator** that reads each plugin's manifest and wires it in.

## Declare a frontend in `package.json` → `eidan.frontend`

```jsonc
"eidan": {
  "frontend": {
    "package": "frontend",                                   // dir copied to apps/web/src/plugins/<name>/
    "stylesheet": "bundle.css",                              // imported globally (screen-specific bits only)
    "routes": [{ "path": "/", "component": "Reports.tsx" }], // default-exported screen -> /p/<name>/<path>
    "api":    [{ "path": "/api/mybundle/reports", "handler": "api/route.ts" }], // mounted as a Next route
    "nav":    { "group": "My Bundle", "sections": [          // NavSection[]
      { "id": "reports", "label": "Reports", "icon": "reports", "href": "/p/mybundle", "mobileHome": 4 }
    ] }
  }
}
```

- **`package`** — the frontend dir; copied to `apps/web/src/plugins/<name>/`, so its components import
  core helpers (`@/lib/auth`, `@/server/*`) and the shared controls (`@/components/ui`).
- **`stylesheet`** — authored against the core tokens; only the screen-specific classes not already in
  `globals.css`. Imported globally.
- **`routes`** — `web/<component>` (default export) mounts at `/p/<name>/<path>`.
- **`api`** — each handler file (`@/server/*`-using `route.ts`) is mounted at the given path. Bundle
  schemas are plugin-private, so the data route ships with the bundle (the REST→Postgres pattern).
- **`nav`** — a `NavContribution` (see `src/lib/shell/nav.ts`); its sections appear in the desktop rail
  (grouped by `group`) and the mobile bottom bar / More. Unknown `icon` names fall back to a glyph.

## Build screens from the shared controls

Import the design-system primitives from `@/components/ui` — don't re-implement them:

```tsx
import {
  Card, StatTile, Delta, TrendChart, LogList, LogRow, ZonePill,
  SegmentedControl, ScopeSwitcher, ProgressRing, EmptyState, Skeleton,
  QuickAddSheet, Sheet, useToast,
} from "@/components/ui";
```

Calm, mobile-first, light/dark, zone-semantic colour. The tokens (`--surface`, `--good/info/warn/alert`,
`--s*`, `--r-*`, `--font-num`…) live in `globals.css`.

## Wiring (automatic at deploy)

List the plugin in `eidan.deploy.json` as usual. At deploy, `assemble`:
1. vendors the `frontend` dir into `apps/web/src/plugins/<name>/` (gitignored),
2. mounts each `api[]` handler as a Next route,
3. regenerates `apps/web/src/plugins/registry.generated.ts` (routes + slots + nav) and
   `bundles.generated.css` (global `@import`s).

The base (no-plugin-frontend) build keeps these empty, so core builds and runs unchanged.
