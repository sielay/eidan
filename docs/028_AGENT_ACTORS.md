# 028 — Agents as first-class actors

Status: Draft
Owner: Core
Related: `docs/011_AUTH_FLOW.md` (Identity, JWT validation),
`docs/003_MEMORY_DDL.md` (§ `users`, `agent_context`, `conversations`,
`messages`), `docs/005_AGENTIC_LOOP.md` (turn context),
`docs/008_SUBAGENT_INVOCATION.md` (spawn linkage),
`docs/022_ESCALATION_ENVELOPE.md` (who an escalation is attributed to)

This document specifies how eidan distinguishes **on whose behalf** a
turn runs from **what initiated it**. Today `Identity` is user-centric
(`011`) and `agent_context` is a persona owned by a user (`003`). But an
autonomous agent — the sentry loop is the first — is sometimes **its
own entity**: it can act **on its own behalf** while serving many
users, and a system-initiated turn (`008`/#184) can run on behalf of a
user, of such an agent, or of another system turn (a chain). One field
cannot carry both meanings.

Out of scope:

- A full multi-principal / multi-tenant identity model (model B below)
  — deferred as the escape hatch, not built here.
- Per-actor RLS policy authoring — owned by the host-schema migration
  surface; this spec only defines the actor distinction the policies
  will key on.

---

## 1. The two axes

| Axis | Type | Meaning |
|------|------|---------|
| **`on_behalf_of`** | `Identity` (a `users` row) | The owner: whose data this is, whose budget it spends, whose RLS applies. |
| **`initiated_by`** | `Actor` `{kind, ref}` | Provenance: *what* started this turn. Never affects cost / RLS / ownership. |

`Actor.kind ∈ { user, agent, turn, schedule }` (extensible). `ref` points
at the originating `users` id, agent service-account id, originating
`messages` id, or trigger id respectively.

## 2. Identity model — service account (decision)

Three models were considered:

- **A — agents always act for a user.** Simplest, but cannot represent
  an agent owning its own memory ("sentry on its own behalf"). Rejected.
- **B — a true principal abstraction** above `users`
  (`principal = user | agent | system`), with every `eidan.*` FK and all
  RLS keyed on `principal_id`. The most general, but a large migration.
  **Deferred** as the future escape hatch.
- **C — service account (chosen).** A first-class agent gets a synthetic
  `eidan.users` row flagged non-human. `on_behalf_of` stays a `users`
  id — a human when the agent acts for a person, the agent's own
  service-account row when it acts for itself. **Zero new identity
  infrastructure**; RLS, cost accounting, and existing FKs work
  unchanged. A useful side effect: an autonomous agent's own cost is a
  visible, separable line.

## 3. Schema

- Add `kind` to `eidan.users`:
  `kind text NOT NULL DEFAULT 'human' CHECK (kind IN ('human','agent','system'))`.
  Human users default in unchanged. A column (not a `metadata` flag) is
  chosen so RLS predicates and admin listings can filter cleanly.
- A lazy-provision helper upserts an agent's service-account `users` row
  on first use (mirrors the `capture-default` agent upsert pattern in
  the capture plugin) — the host does not need a migration per agent.

`initiated_by` needs **no schema**: the `Actor` is stamped into the seed
`messages.metadata` of the turn it starts, mirroring how `008` already
stamps `metadata.parent_message_id`/`depth`.

## 4. Attribution rules

- **Cost, RLS, data ownership** always follow `on_behalf_of`. A turn
  sentry runs for a user bills the user; a turn sentry runs for itself
  bills sentry's service account.
- **`initiated_by` is provenance only.** It drives the audit trail, the
  `022` "who raised this" attribution, and the ownership guard (§5). It
  has no effect on billing or row visibility.

## 5. Ownership guard

A system-initiated turn (#184) must not resume a conversation it has no
right to. Before driving, the runner checks that `initiated_by` is
permitted to act on `on_behalf_of`'s conversation. In the single-operator
phase this is trivially true; the guard is the seam that future
multi-actor installs enforce.

## 6. Provenance chains

`initiated_by.ref` walks upward: a turn initiated by a turn initiated by
an agent reconstructs by following the chain through message metadata.
No dedicated table — the chain is recoverable from the rows the turns
already write.

## 7. Phasing

1. **This design.**
2. The system-initiated turn primitive (#184) ships the **API seam** —
   the two parameters + the metadata `Actor` + the ownership guard —
   assuming **C-light** (an agent flag in `users.metadata`, no DDL), so
   the keystone is not blocked on a migration.
3. This spec then upgrades to **C-typed** (the `users.kind` column) and
   provisions the sentry service account.

## 8. Open questions

- Naming/identity of agent service accounts (one per agent kind? per
  node?).
- Whether `system`-kind users (host/maintenance actions) are distinct
  from `agent`-kind, or collapse.
- The interaction with `011`'s JWT path — service accounts are never
  authenticated via JWT; they are provisioned host-side and never log
  in. The auth surface must treat `kind != 'human'` as non-loginable.
