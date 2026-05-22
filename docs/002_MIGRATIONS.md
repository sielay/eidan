# 002 — Migration Tiering

Status: Draft

Owner: Core

Related: [ARCHITECTURE](./ARCHITECTURE.md) (Stack, Plugins, Release model), [PLUGINS](./001_PLUGINS.md) (§4 Migrations), [DISTRIBUTION AND BUNDLES](./018_DISTRIBUTION_AND_BUNDLES.md) (sibling-repo distribution, open host-schema-migration question in §7)

This document specifies how database migrations are organised across
an Eidan installation. It defines the directory layout, the runner
ordering, the naming convention, the RLS layering strategy, the
rollback policy, and the developer workflow for adding and testing
migrations.

The plugin-level details (per-plugin migration history, `plugin_<name>`
schema, install/uninstall lifecycle) are specified in
`001_PLUGINS.md §4` and are referenced — not duplicated — here.

---

## 1. Scope and tiering model

Eidan ships as a layered product, but the **directory layout does
not encode the tiering**. The layout is identical regardless of
which paid bundles are installed; tier is metadata declared in
plugin manifests (`001_PLUGINS.md §1, §6`).

- **core** — the always-present open-source base. Owns the
  canonical data model: users, sessions, secrets, events,
  agentic-loop tables, audit log. Lives in this repo, in
  `migrations/versions/`. **Core migrations are the only
  migrations on the shared `eidan` schema that ship from this
  repo.**
- **plugins** — independent units (tier declared in the plugin
  manifest per `001_PLUGINS.md §1, §6`) that own their own data
  in their own `plugin_<name>` Postgres schemas. Plugin migrations
  are co-located with plugin code at `plugins/<name>/migrations/`.
  The open repo carries only `tier: core` plugins; paid plugins
  are installed by the eidan CLI from private sibling bundle
  repos (`docs/018 §3`).
- **Plugin-applied refinements on `eidan.*`** — Some paid plugins
  (RLS, cost dashboards) need to refine core tables that live in
  the `eidan` schema rather than in their own `plugin_<name>`
  schema. They do so through a **host-schema migration extension
  point** declared in the plugin manifest, *not* by being a fork
  of core. The mechanical shape of the extension point is the
  open question pinned in `docs/018 §7`; this document treats it
  as a black box and pins only the constraints it must satisfy
  (§2, §5).

Core migrations operate on the shared **`eidan` schema** and live
under the top-level `migrations/` directory in this repo. Plugin
migrations operate on the plugin's private `plugin_<name>` schema;
host-schema migrations registered by a plugin operate on `eidan.*`
under naming rules that prevent collision with core's history (see
sub-options in `docs/018 §7`). This document is primarily about the
shared schema; plugin migrations appear here only where ordering
interacts with the rest.

### 1.1 Why RLS lives in a plugin, not in core

RLS (and family-style multi-user features generally) is meaningful
only in deployments that need it — most self-hosted single-user
installations do not. Shipping it in core would either force RLS
on everyone or require a core-side enable/disable flag that
complicates every read path. Shipping it as a plugin keeps core
simple: install the RLS plugin and the policies appear; uninstall
it and they are dropped.

The invariant remains: **a database with only core migrations
applied is a valid subset of a database with core + the RLS
plugin's host-schema migrations applied.** Uninstalling the RLS
plugin MUST NOT require core to be rewritten.

When an RLS feature genuinely requires a core schema or code
change (a column the policy reads, a session variable the host
must set), the change ships in **core**, not in the RLS plugin
(see §2.2). This keeps host-side support code where it belongs.

---

## 2. Directory layout

```
migrations/                    # one Alembic project on the eidan schema
├── env.py                     # search_path = "eidan, public"
├── script.py.mako
└── versions/
    ├── 20260101_000000_init_users.py            # core
    ├── 20260103_120000_init_events.py           # core
    └── 20260115_093000_audit_log.py             # core

plugins/<name>/migrations/     # each plugin's own Alembic project,
                               # registered with the core runner via
                               # version_locations + branch labels.
                               # Operates on plugin_<name>.* by default;
                               # may also register host-schema migrations
                               # against eidan.* via the extension point
                               # in docs/018 §7.
```

The `migrations/versions/` directory carries **core revisions only**.
Paid plugins do not drop files here; their migrations live under
`plugins/<name>/migrations/` regardless of whether they target the
plugin's private schema or `eidan.*`. There is no `migrations/pro/`
subdirectory and no second Alembic project for paid functionality.

Plugins are flat under `plugins/` (`001_PLUGINS.md §6`) — there is no
`plugins/core/` or `plugins/pro/` grouping. Tier is metadata on the
plugin manifest, not encoded in the migrations tree. The open repo
contains only `tier: core` plugins; paid plugins are dropped into
`plugins/<name>/` by the eidan CLI from private sibling bundle repos
at install time (`docs/018 §3`).

Alembic drives the shared `eidan` schema as a **single project** with
one history table (`eidan.alembic_version`) holding only core
revisions. Plugin-registered host-schema migrations against `eidan.*`
participate via a separate naming convention (see `docs/018 §7`) so
they cannot collide with core's history. Plugin migrations against
the plugin's own `plugin_<name>` schema live inside that schema,
exactly as specified in `001_PLUGINS.md §4`.

### 2.1 What lives where

| Concern                                | Core | Plugin host-schema migration |
|----------------------------------------|------|------------------------------|
| `CREATE TABLE` in `eidan.*`            | yes  | no                           |
| `ALTER TABLE ... ADD COLUMN`           | yes  | no (see §2.2 — supporting columns ship in core) |
| Indexes                                | the ones required for correctness | the ones required for performance at scale |
| `CREATE POLICY` (RLS)                  | no   | yes (see §5)                 |
| `ENABLE ROW LEVEL SECURITY`            | no   | yes                          |
| Triggers, generated columns            | only if core needs them | yes (when supported by core columns) |
| Materialised views, partitioning       | no   | yes                          |
| Seed / reference data for core tables  | yes  | no                           |

### 2.2 Columns required by paid plugins live in core

Plugins do **not** add columns to `eidan.*`. When a paid plugin
(typically the RLS plugin) needs a new column, generated column,
session variable, or runtime hook to do its work — for example a
`tenant_id` referenced by an RLS policy — the change ships as a
**core migration**, accompanied by whatever minimal core code is
required to make the column meaningful (population, indexing,
session-variable setting per §5.2).

Rationale: a column that supports RLS is operationally useless
unless the host knows about it. Hiding it inside a plugin's
host-schema migration would force core to either branch on plugin
presence or run blind. Keeping the column in core means core can
populate, index, and reason about it; the plugin contributes only
the policy that consumes it.

Operators who never install the RLS plugin still get the column
(nullable, unpopulated). The cost is a few NULL columns; the
benefit is core code that does not branch on which plugins are
installed.

---

## 3. Naming convention

Migration filenames are:

```
<UTC-timestamp>_<slug>.py
```

- `<UTC-timestamp>` — `YYYYMMDD_HHMMSS`, generated at creation
  time, in UTC. Timestamps determine lexical and chronological
  order; collisions across developers are resolved by rebasing the
  later migration onto a fresh timestamp.
- `<slug>` — short, lower-snake-case, descriptive of the change.
  Verbs preferred: `add_`, `drop_`, `rename_`, `backfill_`,
  `rls_`, `index_`.

Examples:

```
20260101_000000_init_users.py
20260120_080000_rls_users.py
20260315_110000_backfill_audit_actor.py
```

Inside the file, Alembic's `revision` MUST equal the timestamp
(without underscore), and `down_revision` MUST point at the
previous migration in the same history.

Plugin migrations live at `plugins/<name>/migrations/versions/<UTC>_<slug>.py`
and have their own independent history (`001_PLUGINS.md §4`).
Plugin host-schema migrations against `eidan.*` are a third
namespace: their naming and chaining rules are defined alongside
the extension point (`docs/018 §7`) so they cannot collide with
core's history or with the plugin's own private-schema history.

The `eidan` schema has one linear Alembic history under
`migrations/versions/`, owned entirely by core. Timestamp
collisions between core migrations written in parallel are
resolved by rebasing the later one onto a fresh timestamp and
updating its `down_revision` to the new head.

---

## 4. Runner ordering

There is one migration runner, invoked as `eidan db migrate`. It
operates on a single Postgres database and applies pending
migrations in a single transaction per migration, in this strict
order:

1. **eidan schema (core)** — all pending core migrations under
   `migrations/` to head. The directory holds only core revisions;
   the runner walks the one linear history.
2. **plugins** — for each installed plugin, in topological order
   over `depends_on` (per `001_PLUGINS.md §4.2`), apply that
   plugin's pending migrations from `plugins/<name>/migrations/` to
   head. The plugin's migration directory is discovered via the
   plugin manifest, not by walking a central path. If the plugin
   registered any host-schema migrations against `eidan.*` (via
   the extension point in `docs/018 §7`), those run as part of the
   plugin's migration stage, after the plugin's private-schema
   migrations and within the same topological pass.

```
eidan ──▶ plugin A ──▶ plugin B ──▶ ...
```

### 4.1 Installing or removing a paid plugin

There is no fork to switch to. Installing a paid plugin is a CLI
operation:

```bash
eidan plugin install <bundle>   # CLI clones the named bundle's
                                # plugins into plugins/<name>/
eidan db migrate                # applies any new plugin migrations,
                                # including the plugin's host-schema
                                # migrations on eidan.*
```

See `docs/018 §3` for the install flow and `001_PLUGINS.md §4` for
the plugin migration lifecycle.

Removing a paid plugin runs its uninstall path
(`001_PLUGINS.md §4.2`), which executes the plugin's downgrade
migrations against `plugin_<name>` (forward-only does not apply to
the plugin's own schema — uninstall is the routine downgrade path).
For host-schema migrations the plugin registered against `eidan.*`,
the plugin SHOULD ship downgrade migrations that drop the policies,
indexes, or triggers it added so uninstall is reversible. Core
columns added under §2.2 to support the plugin remain in place —
they are part of core and are not removed when the plugin is
uninstalled.

### 4.2 Single connection, one history

The runner opens one connection, sets `search_path = eidan, public`,
and runs Alembic against `eidan.alembic_version`. There is one
linear history on the `eidan` schema; there is no parallel
`alembic_version_pro` table or other tier-specific history.

### 4.3 Failure handling

A failure aborts the whole run. The DB is left at the last
successfully applied migration. The runner exits non-zero and
prints the failing revision. Operators are expected to fix
forward; see §7.

---

## 5. RLS strategy

Core defines tables with no RLS. **The RLS plugin** (delivered as a
paid plugin via the host-schema migration extension point in
`docs/018 §7`) enables RLS and defines policies on `eidan.*`. This
split exists because RLS is meaningful only when the operator has a
multi-user / multi-tenant deployment; most self-hosted single-user
installations do not need it.

The contract below applies to any plugin that registers host-schema
migrations against `eidan.*` for RLS purposes. In practice only one
such plugin is expected — the RLS plugin shipped in the paid
baseline bundle — but the contract is generic.

### 5.1 The contract

For every core table `eidan.<t>` that the RLS plugin secures, a
host-schema migration MUST:

1. `ALTER TABLE eidan.<t> ENABLE ROW LEVEL SECURITY;`
2. `ALTER TABLE eidan.<t> FORCE ROW LEVEL SECURITY;` (so the table
   owner is not exempt — required because the host connects as the
   owner)
3. Create at least one named policy with a stable name of the form
   `rls_<table>_<intent>` (e.g. `rls_users_self_read`,
   `rls_events_tenant_isolation`).
4. Define a default-deny posture: any path not matched by a policy
   is denied.

Example skeleton:

```python
def upgrade() -> None:
    op.execute("ALTER TABLE eidan.users ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE eidan.users FORCE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY rls_users_self_read ON eidan.users
        FOR SELECT
        USING (id = current_setting('eidan.current_user_id')::uuid)
    """)
```

### 5.2 Session variables

RLS policies reference `current_setting('eidan.<key>')` for
per-request context (current user id, current tenant id, role).
**Core** is responsible for setting these on every connection
checkout via a `SET LOCAL` issued by the request middleware. The
exhaustive list of session keys an RLS-providing plugin may rely
on is part of the core public contract and lives in the host's
`eidan.runtime.session` module.

A plugin MUST NOT introduce new session keys without a
corresponding core change shipped first (per §2.2 — host-side
support for any column or session variable the policy reads lives
in core).

### 5.3 What core guarantees to RLS-providing plugins

Core promises:

- Tables in `eidan.*` will not be dropped or renamed across
  patch/minor releases without a deprecation window of one minor
  version.
- Primary-key columns will not change type.
- Session variable names declared in `eidan.runtime.session` are
  stable across minor versions.

Anything not in that list is fair game for core to change, and
plugin host-schema migrations that depend on it carry the burden
of catching up.

### 5.4 Plugin tables and RLS

Plugin tables live in `plugin_<name>` schemas (`001_PLUGINS.md §4`)
and are owned by the plugin. The RLS plugin does NOT add RLS to
other plugins' tables; plugins enable their own RLS in their own
migrations if they need it. The RLS plugin's reach stops at the
`eidan` schema boundary.

---

## 6. Rollback policy

Eidan is **forward-only in production.** Once a migration has run
against a production database it is never downgraded. Mistakes are
corrected by a new forward migration that undoes or amends the
prior one.

### 6.1 What this means in practice

- Every migration MUST be designed assuming it can never be rolled
  back. Destructive changes (dropping columns, dropping tables)
  proceed in two releases: ship a migration that stops writing to
  the column, then in a later release ship a migration that drops
  it. See `docs/ARCHITECTURE.md (Release model)` for the cadence.
- `downgrade()` functions in core and plugin migrations are written
  anyway — they are used by the test suite and the dev workflow
  (§8), not by production. The CI lint rejects an empty
  `downgrade()` to keep the path runnable for tests, but the
  production runner refuses `alembic downgrade` against a database
  whose `eidan.deployment_mode` setting is `production`.
- Plugin migration downgrades run during plugin uninstall
  (`001_PLUGINS.md §4.2`). That is the only routine downgrade path
  in the system and it is scoped to the plugin's own schema.

### 6.2 Plugin host-schema migrations are still forward-only in production

There is no shortcut to "remove the RLS plugin" against a populated
production database by replaying its downgrade history. Plugin
host-schema migrations follow the same forward-only rule core does
when run in production: reverting a plugin-added policy, index, or
trigger against production is a new forward migration that drops
it.

Plugin authors still write `downgrade()` for the dev/test path and
for the plugin's `on_uninstall` lifecycle hook
(`001_PLUGINS.md §4.2`). Downgrades are written so they are safe to
run against a populated database (dropping a policy, disabling RLS,
or dropping an index does not lose data), so the same migration
file can also serve as reference for the operator's hand-written
drop-forward when needed.

### 6.3 No squashing

Migration history is not squashed. The full chain from the empty
schema to head is preserved. New installations replay it; this is
acceptable because Eidan instances are small (single-tenant
self-hosted) and the runtime cost is bounded.

---

## 7. Repairing a bad migration

Because there is no rollback in production, repair is always a
forward step. The pattern is:

1. Leave the offending migration in place. Do not edit a migration
   that has been released.
2. Write a new migration that corrects the state (drop the bad
   index, fix the constraint, backfill the wrong column).
3. If the offending migration broke `upgrade()` partway through
   for some operators, the new migration MUST be idempotent
   (`IF EXISTS` / `IF NOT EXISTS` guards) so it converges from
   either state.

A migration that has been merged to `main` but not yet tagged in a
release MAY be amended in place; once tagged, it is frozen.

---

## 8. Dev workflow

### 8.1 Adding a migration

For a core change against the `eidan` schema:

```bash
eidan db revision -m "add user_settings"
# generates migrations/versions/<timestamp>_add_user_settings.py
# with revision/down_revision pre-filled to the current head
```

For a plugin change: see `001_PLUGINS.md §4`. Plugin migrations are
generated and run by the plugin's own Alembic env, not by this
command. For plugin host-schema migrations against `eidan.*` (the
extension point in `docs/018 §7`), the plugin's own tooling
generates the file under the naming convention pinned there.

The CLI:

- Picks the UTC timestamp at generation time.
- Resolves `down_revision` to the working tree's current head (no
  surprise drift between author and reviewer).
- Writes a stub with both `upgrade()` and `downgrade()` and a
  failing assertion in `downgrade()` so the developer must
  consciously fill it in.

### 8.2 Testing against a fresh DB

`eidan db reset` drops and recreates the database, then runs
`eidan db migrate` to head. The full test suite uses this against
an ephemeral Postgres (testcontainers / a per-test-run database)
so every CI run exercises the full forward chain from empty.

In this repo's CI, the chain is core-only — the test database is
brought up with `migrations/versions/` applied to head and no
paid plugins installed. Paid bundle repos run their own CI that
adds the bundle's plugins on top of a core install (including any
host-schema migrations the plugin registers) and verifies the
layered state is coherent. The cross-repo test matrix is owned by
each bundle, not by core.

### 8.3 Testing the forward-fix path

For any migration that touches existing data, the author writes a
test that:

1. Loads a fixture representing the pre-migration state.
2. Applies the migration.
3. Asserts the post-migration state.

These fixtures live next to the migration as
`<timestamp>_<slug>.fixture.sql` and are picked up automatically by
the migration-test harness.

### 8.4 Testing rollback (dev only)

`eidan db downgrade -1` exists for local iteration. It is gated by
the `eidan.deployment_mode` setting being `dev` and refuses to run
in `production`. CI runs `downgrade` then `upgrade` once per
migration to ensure the pair is round-trippable for the test path
described in §6.1.

---

## 9. Reserved for later specs

Out of scope here, deferred to follow-ups:

- Online schema-change strategy for very large tables (e.g.
  `pg_repack`, batched backfills).
- Cross-database replication / read-replica migration handling.
- Backup-and-restore mechanics (point-in-time recovery, snapshot
  policy).
- Migration squashing or release-boundary checkpoints, should the
  forward chain ever become too costly to replay.
