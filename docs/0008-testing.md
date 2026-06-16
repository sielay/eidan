<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0008 — Testing

Status: **Shipped** — `node:test` specs run through matbot's loader; gated by the `Tests` CI workflow.

## Running tests

```bash
pnpm test            # all specs across packages
# or one package:
pnpm --filter @eidandev/routines test
```

`pnpm test` runs:

```bash
node --import ./external/matbot/apps/cli/register.js --test "packages/*/src/*.test.ts"
```

`register.js` is matbot's TypeScript loader — it strips types and resolves eidan's `.js`-extension
import convention (`import { x } from './foo.js'`) to the `.ts` sources, so specs run straight from
source with **no build step**. Use **Node 24+** (native type-strip).

## Writing a spec

Co-locate `*.test.ts` next to the source, using the built-in runner (no framework dependency):

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule } from './schedule.js';   // .js extension, points at schedule.ts

describe('parseSchedule', () => {
  it('parses a daily time', () => {
    assert.deepEqual(parseSchedule('08:00'), { days: null, minutes: 480 });
  });
});
```

Add the package's `test` script if missing (note the `../../` to the loader from a package dir):

```json
"scripts": { "test": "node --import ../../external/matbot/apps/cli/register.js --test src/*.test.ts" }
```

## What to test

Favour **pure, deterministic logic** — it runs with no `node_modules` or database, so the CI gate
stays fast (the current specs need neither). Good targets: parsers/validators (schedules, route maps,
allowlists), formatting (message chunking), and any branch-heavy helper. DB-backed stores and HTTP
handlers need a heavier harness (a throwaway Postgres) — not yet set up; keep that logic thin and
push the testable parts into pure helpers.

## CI

`.github/workflows/test.yml` runs the suite on every PR and push to `main` (checkout with
submodules → Node 24 → run). No install — the specs are pure (type-only cross-package imports are
erased at load). When a spec first needs a runtime dependency, add a `pnpm install` step there.

## Current coverage

- `@eidandev/routines` — `schedule.ts` (parse / due-window / timezone / validation).
- `@eidandev/frontend-telegram` — `allowlist.ts` (admission) + `bot.ts` `splitText` (chunking).
- `@eidandev/notify` — `loadRoutes` (route-map parsing).
