# 023 — Predecessor-session lookup ("seance")

Status: Draft
Owner: Core
Related: `docs/ARCHITECTURE.md` (Agentic loop, Memory model),
`docs/003_MEMORY_DDL.md` (§2 `conversations`, §3 `messages`, §5
`notes`, §6 `knowledge`), `docs/005_AGENTIC_LOOP.md` (§5.5 primary
loop — the caller this primitive serves), `docs/014_UI_SURFACE.md`
(CLI REPL and web UI surfaces), `docs/017_KNOWLEDGE_LINKING.md`
(the linked-graph shape predecessor lookups traverse)

This document specifies the **mechanism for querying an earlier
conversation as live context for a new one** — what Gas Town calls
*seance*: "ask my predecessor session what they found." Eidan
already persists every turn (`005 §1.1` eager persistence) and
already curates knowledge into a linked graph (`017`). What was
missing was the **conversational primitive** that says:

> *"Here is what was being worked on three weeks ago in conversation
> X. Pull the relevant notes / knowledge / events into the current
> turn's context, and let me query that earlier agent state without
> manually citing it."*

This is the just-in-time loading doctrine applied specifically to
*prior conversations as queryable context*, with two surfaces: a
CLI command (today) and a web UI affordance (Phase 2).

Phase 1 (this commit): one-shot CLI query at
`apps/cli/eidan_cli/seance.py`. The vocab below is pinned;
the open design questions are reserved for the Phase 2 follow-up.

Out of scope:

- Full-text search across prior conversations. This spec covers
  *targeted lookup of a known conversation*; search is a separate
  concern handled by the knowledge graph (`017`).
- Federated lookup across instances. Eidan is single-operator and
  conversations live in the operator's Postgres — this is local.
- Privacy / redaction policies. A future spec, not blocking the
  primitive.

---

## 1. Vocabulary

| Term                       | Definition                                                                                                                                       |
|----------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------|
| **Predecessor session**    | An earlier `conversations` row, identified by UUID today. Slug + natural-language resolution land with the §3 follow-up.                          |
| **Seance call**            | A one-shot Haiku-class LLM call that takes the predecessor's transcript as input and the operator's question as the prompt. One `llm_calls` row.  |
| **Context bundle**         | The materialised payload sent into the seance call. Phase 1 ships the verbatim trailing window (40 turns × 400 chars). Phase 2 adds a summariser. |
| **Continuation reference** | The seance prompt + answer persist as a `[seance]`-tagged user message on the consulted conversation, with `metadata.kind='seance'`.              |

## 2. Phase 1 CLI surface

```
eidan seance --list                          # candidate predecessors
eidan seance --conv <uuid> -p "<question>"   # one-shot query
```

`--list` queries `eidan.conversations` for the resolved user's
recent rows (newest first, `deleted_at IS NULL`).

`--conv` loads the conversation's user/assistant transcript
(`messages` filtered to those two roles, tool turns dropped),
renders the trailing 40 turns capped at 400 chars each, and
calls the configured provider with a stable system prompt
explaining the seance pattern. Streams the answer to stdout.

The seance call attributes back as one `llm_calls` row on the
**consulted** conversation with `role='other'` and
`metadata.kind='seance'`. The prompt itself lands as a
`[seance]`-tagged user message on the same conversation with
`metadata.kind='seance'` so the audit trail shows what was asked.
Tool-call semantics — the seance is a query, not a turn.

## 3. Reserved for Phase 2

The open design questions for the follow-up spec:

1. **Bundle shape.** Sending the verbatim trailing window is
   expensive and dilutive. Phase 2 adds a summariser pass
   (`005 §1` summariser role) that builds a digest, plus the
   operator's question selects which raw messages survive verbatim.
2. **One-shot vs sustained.** Gas Town's seance has both modes
   (one-shot + a deeper sustained session). Phase 1 ships one-shot;
   sustained is reserved.
3. **CLI surface naming.** `/seance` reads as cute-but-opaque;
   `/recall` is clearer but overloaded; `/ask-past` is descriptive
   but ugly. Phase 1 picks `seance`. Renaming is cheap if the
   operator community settles on something better.
4. **Cross-conversation linking in the knowledge graph.** A seance
   creates an edge between two conversations. `017` defines linked
   knowledge but does not yet define the conversation-to-conversation
   edge type. The follow-up extends `017` with the conversation
   edge.
5. **Slug resolution.** Phase 1 takes UUIDs only. `eidan seance --conv
   <slug>` waits on a slug-from-title generator — landing alongside
   the `knowledge` slug work in `017`.
6. **Web UI affordance.** A `/seance` route + a "Consult a prior
   conversation" affordance on the conversation view. Reserved
   until the CLI shape sees real use.

## 4. Non-goals

- Multi-predecessor queries ("compare what conversation A and B
  decided"). Single predecessor only.
- Automatic predecessor suggestion ("you probably want to consult
  conversation X"). Operator-driven only.
- Editing the predecessor's state from the seance. Read-only.
- Reaching across users in a multi-user install. Single
  operator's own conversations only — the resolver enforces
  `WHERE user_id = $1` on every read.
