# @eidandev/procedures

**Sandboxed, agent-authored procedures** — let the agent write JavaScript that
composes an allowlisted subset of eidan's own tools, run it in a sealed
`isolated-vm` V8 isolate, and optionally promote a proven procedure into the
knowledge graph. The point: collapse a deterministic multi-step tool pipeline
(e.g. a data migration) into a single step instead of many turns, without ever
handing the procedure the filesystem, network, or secrets.

Inside the sandbox the **only** host capability is `await callTool(name, input)`
(plus `console.log`); `fetch`, `process`, `require`, and `fs` do not exist, so a
procedure can only orchestrate the allowlisted tools — never escape them. It
registers the single `procedures` tool below; no service is registered.

## Tools

| Tool | Purpose |
|------|---------|
| `procedures` | One tool, four actions. `{action:'run', source}` — run JS now (ephemeral). `{action:'promote', name, source}` — save a proven procedure to the knowledge graph (prompts the user to approve first). `{action:'run_saved', name}` — run a previously promoted procedure. `{action:'list'}` — list promoted procedures. Returns the procedure's result plus captured logs and the names of tools it called. |

## Example

> **You:** Copy every note tagged "draft" into long-term memory, then list them.
>
> → the agent calls `procedures({ action: "run", source: "const found = await callTool('recall', { query: 'draft' }); for (const e of found.entries) await callTool('remember', { skill: 'archive', title: e.title, body: e.body }); return found.entries.length;" })`
>
> Only `recall`/`remember` resolve inside the isolate — any other tool throws "tool not exposed".

## Layout

- `src/index.ts` — the `MatbotPluginSpec`; builds the `Db`/`ProcedureStore`, reads the tool allowlist from `EIDAN_PROCEDURE_TOOLS`, and registers the `procedures` tool.
- `src/runner.ts` — `runProcedure`: spins a bare `ivm.Isolate` (memory + timeout limits), injects the `console`/`callTool` bridge, runs the source wrapped in an async IIFE, and returns logs/result/error/toolCalls.
- `src/procedures-tool.ts` — the `procedures` `Tool` and the host bridge: resolves an allowlisted tool, runs it in the same turn `ToolContext` (ambient principal/session carry through), reduces its event stream to one value (errors become thrown rejections the procedure can catch). `promote` gates on `ctx.prompt` approval.
- `src/procedure-store.ts` — `ProcedureStore`: a promoted procedure is a knowledge-graph node (`eidan.knowledge` row, `skill='procedure'`, body = JS source); `save`/`get`/`list`, all `user_id`-scoped.
- `src/db.ts` — the principal-stamping transaction helper (sets `eidan.current_user_id` from the ambient `Principal`).

## Schema

No SQL of its own. Promoted procedures are rows in the shared `eidan.knowledge`
table under `skill='procedure'` (versioned by the `(user_id, skill, title)`
upsert), applied by the core migrate runner.

## Config

- `EIDAN_DATABASE_URL` (or `DATABASE_URL`) — Postgres connection (**required**).
- `EIDAN_PROCEDURE_TOOLS` — comma list of tool names a procedure may call
  (default `remember,recall`). Deny-by-default: anything not listed is unreachable.
