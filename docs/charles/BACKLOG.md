# Charles backlog (consolidated)

Working list for the business bundle after the fold into the eidan monorepo
(`feat/fold-charles-into-core`). Merges the GitHub issues (eidan core + the
charles bundle) with the tasks logged in operator memory, and
reconciles them against what the matbot port **already shipped** (now in
`packages/charles-ventures` + `packages/charles-decks`).

Status legend: ✅ done · 🟡 partial · ⬜ not started · ⚠️ defect.
"Iterable here" = doable on charles code already in this branch (no core/external gate).

---

## A. Reconcile the tracker (the matbot port already shipped these)

| Issue | What | Status |
|-------|------|--------|
| charles#9 | Scaffold ventures skeleton | ✅ done — close |
| charles#2 | ventures v0.1: registry + `venture_id` spine | 🟡 built (`ventures_create/list`, `venture_get/update/reparent`, `venture_items`, `venture_set_plan`; schema `ventures`/`venture_items`/`venture_resources`). Verify *seed eidan as venture #1* + soft-delete + holding-tree, then close. NB issue says Alembic/Python — stale, it's matbot-TS now. |
| charles#8 | Deck tool (`render_deck`) | ✅ closed; `charles-decks` in-tree |
| charles#16 (1st box) | Companies House identity (`venture_lookup_company`) | ✅ done (`src/identity.ts`) |

## B. Ventures hardening — **iterable here now**

Track V from memory (`ventures_resource_cleanup`); prereq for signals & social.
Operator complaint: resources are a "free-text mess — providers are free text,
ids are free text, and we link stuff we don't support."

- ✅ **V3 — `sql/0004_venture_resource_provider.sql` deploy bug** (fixed). Bare
  `ADD CONSTRAINT ... CHECK` with no data step would fail the whole migration on
  any pre-existing non-conforming `provider` row. Fixed: trim/lowercase data
  step + `NOT VALID` (enforces on new writes, won't reject legacy rows);
  documented `VALIDATE CONSTRAINT` follow-up gated on V1/V2.
- ✅ **V1 — adapter-registry-driven provider list (supported-only)** (done).
  New `src/providers.ts` registry: each `(kind, provider)` carries
  `status: available | planned`; attach offers/validates available-only.
  Honest current state — only `manual` is available (the always-on local-store
  adapter); all vendor/platform providers are `planned` (known + roadmapped, not
  attachable). DB CHECK in `0004` stays the wider
  known-universe backstop, so promotion is a code change, no migration.
- ✅ **V2 — resolve/validate `external_ref`** (done). `resolveRef` hook per
  adapter, wired into the attach tool before persist. Manual adapters normalise:
  social handles strip a leading `@` and reject whitespace (handle or URL);
  list/property names trimmed + non-empty. Live adapters will add
  against-the-provider checks when they ship. Unit-tested (`providers.test.ts`,
  5 cases green).

## C. Signals track — marketing-pivot priority (greenfield, in-repo)

Per `marketing_track_pivot`, front of the queue. New `packages/charles-signals/`
(read-others; distinct from publish-self `social`). Data posture per
`charles_data_minimisation`: watch-list persisted, raw observations
read-through/ephemeral (no content warehouse). Venture-scoped; eidan = venture #1.

- ⬜ charles#3 — signals plugin scaffold + **manual adapter**
  (`signals_source_add/list`; watch-list schema only).
- ⬜ charles#4 — `analyze-competitor-post` skill → emit linked nodes into the
  **core knowledge graph**.
- ⬜ charles#5 — `reconstruct-funnel` + `debate-idea` (bicameral) skills.
- ⬜ charles#6 — `draft-mimic-campaign` + intel→social handoff.
- ⬜ charles#7 — epic umbrella.

## D. Venture integrations & finance (design-first / external deps)

All must follow `charles_provider_abstraction` (interface+adapter, never
vendor-baked) and `charles_data_minimisation` (read-through, no hoarding).

- ⬜ charles#16 (remainder) — Stripe revenue; **vault accessor from a bundle
  plugin** (blocker for account-scoped secrets); Xero OAuth; report parsers
  (KDP/D2D/Amazon — low feasibility); `venture_financials` ledger;
  multi-jurisdiction identity (OpenCorporates).
- ⬜ charles#1 — cost projection for Accounting Charles (depends on core#204 +
  pro pricing; parked/design).

## E. Core-side enablers (blockers — belong in core, not this branch)

- ⬜ **eidan#284** — plugin **router + frontend mounting** (`register_router`
  is a stub). `charles-ventures` ships a `frontend` block → won't mount until
  this lands. Direct dependency.
- ⬜ **Core primitive: transient / redacted-at-rest tool results**
  (`charles_data_minimisation`) — core eagerly persists every message,
  defeating Charles read-through minimisation.
- ⬜ **Agents-with-triggers** (core Epic **#346**) — substrate for Charles
  **role agents** (accounting/social Charles).

---

**Order:** A (close/verify) → **B** (ventures cleanup; V3 bug first) → C
(signals scaffold). D and E are design- or core-gated.
