---
id: write-a-plugin
title: Write a plugin
---

# Write a plugin

A plugin is **one TypeScript module** that exports `const plugin` and extends the host through
matbot's seams — tools, hooks, a storage/knowledge backend, providers, frontends, and the service
registry. eidan runs the `.ts` directly (Node 24+ type-strip, no build step).

## Scaffold

Create `packages/<name>/` with:

- `package.json` — `name: @eidandev/<name>`, `matbotRuntime: ["node"]`,
  `exports: { ".": "./src/index.ts" }`, and a `link:` dep on `@matatbread/matbot-plugin-api`.
- a strict `tsconfig.json`.
- `src/index.ts` exporting the plugin.

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: { description: 'What this plugin does.' },
  async setup(services: MatbotServices) {
    // register tools, hooks, or a service here
    for (const tool of myTools()) services.tools.register(tool);
  },
};
```

Then list it in `matbot.yaml` (and, to ship it in a deploy, add it to `CORE_PLUGINS` in
`deploy/manifest.mjs` or a bundle).

## The seams

- **Tools** — `services.tools.register({ name, description, inputSchema, executor })`. The executor is
  an async generator yielding `{ type: 'result', value }` or `{ type: 'error', message }`.
- **Hooks** — `services.hooks.register({ on: 'screen'|'contribute'|'toolcall'|'toolresult'|'followup', handler })`.
- **Services** — `await services.register('YourService', impl)`, then other plugins call
  `services.YourService?.…`. Name the key after the interface.
- **Own data** — a plugin owns a `plugin_<name>` Postgres schema (create it idempotently in setup);
  core memory tables live under `eidan.*`.

## Conventions that will bite you

- **Erasable-only TypeScript.** No parameter properties (`constructor(private x)`), no enums, no
  namespaces — Node's strip-only runtime rejects them (but `tsc` allows them, so only a real run
  catches it).
- **SPDX header** on every new `.ts`/`.js` file: `SPDX-License-Identifier: AGPL-3.0-or-later` (CI
  enforces it).
- `snake_case` on the wire and in Postgres; soft-delete via `deleted_at` + partial indexes.

See the [`packages/journal`](https://github.com/sielay/eidan/tree/main/packages/journal) plugin for a
compact end-to-end example (schema + tools + a screen hook + tests), and each repo's `CLAUDE.md` for
the authoritative conventions.
