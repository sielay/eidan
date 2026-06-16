<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0017 — Procedures (sandboxed agent-authored automations)

Status: **Shipped** — `@eidandev/procedures`.

## Goal

Let the agent collapse a deterministic multi-step tool pipeline (e.g. a data migration, a recall →
transform → remember loop) into **one** step by writing JavaScript that composes other eidan tools —
without ever giving that JS the network, filesystem, or secrets. A proven procedure can be **promoted**
to the knowledge graph (with human approval) and re-run later by name.

## How it works

- **A sealed isolate, one capability.** `runProcedure` executes the source in a bare `isolated-vm`
  V8 isolate (default 128 MB / 30 s). Inside, `fetch`, `process`, `require`, and `fs` **do not
  exist**. The single host capability is `await callTool(name, input)`; a tiny `console.log` shim is
  also bootstrapped. Everything marshals across the isolate boundary by JSON string.
- **The bridge enforces the allowlist.** Host-side, `callTool` resolves the named tool from the
  registry and runs it to completion **in the same turn context** — so the ambient principal and
  session carry through — reducing its event stream to one value. A tool not on the allowlist (or the
  `procedures` tool itself, to prevent recursion) is rejected; a tool error becomes a thrown
  rejection the procedure can `try/catch`.
- **Operator-controlled tool surface.** `EIDAN_PROCEDURE_TOOLS` is a comma list of the tools a
  procedure may compose. It defaults to `remember,recall` — useful out of the box, exposes nothing
  that can leave the sandbox. Deny-by-default: only listed tools are reachable.
- **Four actions** (the `procedures` tool):
  - `run { source }` — run JS now, ephemeral.
  - `promote { name, source }` — save a proven procedure to the knowledge graph. **Gated on human
    approval** (`ctx.prompt` — the operator must type `yes`). A bicameral-critic pre-review is the
    documented follow-on.
  - `run_saved { name }` — run a previously promoted procedure by name.
  - `list` — list promoted procedures.
- **Promoted = a knowledge node.** `ProcedureStore` stores a promoted procedure as a row in
  `eidan.knowledge` under `skill='procedure'` (body = the JS source), so it is recallable like any
  other knowledge and versioned by the same `(user_id, skill, title)` upsert. Reads carry an explicit
  `user_id` predicate so scoping holds even on a role where RLS isn't FORCEd.

## Why a VM, not a subprocess

The threat model is "agent-authored code I didn't review." A subprocess would inherit the host's
ambient authority (env, fs, network); the isolate starts from **zero** authority and is handed back
exactly one function. The allowlist then bounds what that one function can reach — so the blast radius
of a hostile or buggy procedure is "the allowlisted tools, as this user," nothing more.

## Config

| Env | Default | Meaning |
|---|---|---|
| `EIDAN_PROCEDURE_TOOLS` | `remember,recall` | comma list of tools a procedure may `callTool()`. |
| `EIDAN_DATABASE_URL` (or `DATABASE_URL`) | — | Postgres, for the promoted-procedure store. Required. |

## Files of record

- `packages/procedures/src/runner.ts` — `runProcedure` (the isolate, the `callTool` bridge contract).
- `packages/procedures/src/procedures-tool.ts` — the `procedures` tool (4 actions) + the host-side bridge / allowlist.
- `packages/procedures/src/procedure-store.ts` — promote/get/list over `eidan.knowledge` (`skill='procedure'`).
- `packages/procedures/src/index.ts` — boot: builds the allowlist from env, registers the tool.
- Related: [[0011-memory]] (promoted procedures are knowledge nodes); [[0013-architecture]].
