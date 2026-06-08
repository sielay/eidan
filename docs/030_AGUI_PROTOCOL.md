# 030 — AG-UI as the agent↔frontend protocol

Status: Draft

Owner: Core

Related: [005 — Agentic loop](./005_AGENTIC_LOOP.md) (the turn runner
this maps from), [004 — Schemas](./004_SCHEMAS.md) (the codegen
carve-out + camelCase exception), [014 — UI surface](./014_UI_SURFACE.md)
(the chat panel that consumes it), [013 — MCP surface](./013_MCP_SURFACE.md)
(the *other* boundary — tools in, not events out).

eidan speaks **[AG-UI](https://github.com/ag-ui-protocol/ag-ui)** (the
Agent-User Interaction Protocol) as its **protocol of record** for the
event stream between the backend turn runner and any frontend. This
replaces the earlier eidan-private SSE shape (`event: chunk` /
`event: complete`). Epic: #263.

## 1. Why AG-UI

The turn runner (`run_turn`, [005 §5.5](./005_AGENTIC_LOOP.md)) produces
a stream of events — assistant text, tool calls, completion. The web
chat panel, the CLI REPL, and (later) inbound Slack all need to render
that stream live. Rather than maintain an eidan-private wire and a
bespoke decoder per surface, we adopt AG-UI: a standard, versioned event
vocabulary with official encoder/decoder SDKs and free interop with any
AG-UI-speaking frontend or middleware.

**Decision (2026-06-08):** adopt the official SDKs — `ag-ui-protocol`
(Python; `ag_ui.core` events + `ag_ui.encoder.EventEncoder`) on the
backend, `@ag-ui/core` / `@ag-ui/client` / `@ag-ui/encoder` on the web —
and **replace** the old `/api/turn` wire outright (not an additive
second transport).

## 2. Wire shape

`POST /api/turn` returns `text/event-stream`. Each SSE frame is a single
`data:` line carrying one AG-UI event as JSON, terminated by a blank
line:

```
data: {"type":"RUN_STARTED","threadId":"<conversation_id>","runId":"<run>"}

data: {"type":"TEXT_MESSAGE_START","messageId":"<m>","role":"assistant"}

data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"<m>","delta":"Hello"}
```

Two things differ from every *other* eidan wire, and are **deliberate
carve-outs** (see [004 §Why JSON Schema as the source](./004_SCHEMAS.md)):

1. **camelCase.** AG-UI serialises `messageId`, `toolCallId`,
   `threadId`, etc. — not eidan's snake_case. The SDK encoder emits
   `by_alias=True`. This exception is scoped strictly to the AG-UI
   envelope; eidan's own DTOs (including the `/api/turn` **request**
   body, `TurnInput`) stay snake_case. Each surface's decoder lowers
   AG-UI camelCase back into the app's snake_case at the boundary.
2. **The event name lives in the JSON `type` field**, not a named SSE
   `event:` line. Decoders switch on `type`, not on the frame name.

The AG-UI event types are consumed from the **SDK**, not codegen'd
through `@eidan/schemas`. For that one envelope the SDK is the source of
truth; owning a hand-maintained parallel copy of an external standard's
30+ event types would only drift against the spec.

## 3. Event mapping (runner → AG-UI)

The backend maps `run_turn`'s internal event stream onto AG-UI via
`AguiEmitter` ([apps/backend/eidan_backend/http/agui.py](../apps/backend/eidan_backend/http/agui.py)).
The emitter is a pure stateful map; the HTTP handler keeps the
disconnect check, the auto-title hook, and the error beacon.

| Runner event (`loop.py`)        | AG-UI event(s)                                              |
|---------------------------------|------------------------------------------------------------|
| *(turn opens)*                  | `RUN_STARTED` (thread_id = conversation_id, synthetic run_id) |
| `AssistantChunk`                | `TEXT_MESSAGE_START` (lazily, first delta) → `TEXT_MESSAGE_CONTENT` |
| `ToolCallStart`                 | `TEXT_MESSAGE_END` (if a text run was open) → `TOOL_CALL_START` |
| `ToolCallArgs`                  | `TOOL_CALL_ARGS` (the whole args JSON as one delta)        |
| `ToolCallEnd`                   | `TOOL_CALL_END`                                            |
| `ToolCallResult`               | `TOOL_CALL_RESULT`                                          |
| `TurnComplete`                  | `TEXT_MESSAGE_END` (if open) → `RUN_FINISHED` (ids in `result`) |
| *(uncaught exception)*          | `TEXT_MESSAGE_END` (if open) → `RUN_ERROR`                  |

Notes:

- **Tool-call events** come from the runner surfacing tool-call
  boundaries in its yielded stream (#265). Before that, tools were
  invisible on the wire and the UI reconstructed them from persisted
  rows after the turn. They are a pure *observation* of work already
  being persisted — emitting them never changes persistence, which
  stays authoritative ([005 §5.1](./005_AGENTIC_LOOP.md)).
- **Text bracketing.** `run_turn` streams raw text deltas with no
  message boundaries. The emitter lazily opens a text message on the
  first delta and closes it when a tool call interrupts or the turn
  ends. A turn that interleaves text → tool → text therefore produces
  **two** AG-UI text messages; a client concatenates same-turn text to
  recover the full assistant text in one bubble.
- **Persisted ids.** The ids `run_turn` wrote (`user_message_id`,
  `assistant_message_id`) ride out on `RUN_FINISHED.result` so a
  reloading client can reconcile the live stream against
  `eidan.messages`.
- **`is_error` on tool results.** AG-UI's `TOOL_CALL_RESULT` has no
  error flag, so a *live* tool error surfaces as its error text in
  `content`. The persisted `messages.tool_results.is_error` is
  unaffected, and the post-reload view (which reads the rows) renders
  the error state correctly. Promoting a typed error onto the live wire
  (e.g. a `CUSTOM` event) is a possible follow-up.

## 4. Consumers

- **Web** ([apps/web/src/lib/api/turn.ts](../apps/web/src/lib/api/turn.ts))
  — decodes the AG-UI stream with `@ag-ui/core`'s `EventType` inside the
  existing auth'd-`fetch` + async-generator reader, lowering each event
  into a slim snake_case `TurnEvent` union the chat panel reduces over.
  Tool calls render live on the streaming row (#267; converges with the
  generative-tool-rendering work, #245).

  > Implementation note: `@ag-ui/client` also ships an rxjs-based
  > `parseSSEStream` / `HttpAgent`. We deliberately did **not** adopt
  > those for the chat panel — they impose an rxjs Observable + agent
  > state machine that doesn't fit eidan's `authFetch` + async-generator
  > + React-`setState` flow. The wire is AG-UI and the types come from
  > the SDK; only the transport reader stays eidan's. Revisit if/when we
  > want the full client runtime (shared state, frontend actions).

- **CLI REPL** ([apps/cli/eidan_cli/repl.py](../apps/cli/eidan_cli/repl.py))
  — the HTTP-fallback transport decodes the same AG-UI frames and renders
  text + an inline tool indicator. The in-process transport consumes
  `run_turn` directly and filters the runner events by type.

## 5. Out of scope (follow-ups)

- AG-UI **shared state** (`STATE_SNAPSHOT` / `STATE_DELTA`) and
  **frontend actions** — a larger surface that would pull in more of the
  `@ag-ui/client` runtime. Not needed for streaming a turn.
- **Inbound Slack** over the same AG-UI event model (#270) — deferred to
  the inbound-surface work (Slack is outbound-notify-only today).
- Retiring the now-dead `TurnChunk` / `TurnComplete` schemas under
  `packages/schemas` once no consumer references them.
