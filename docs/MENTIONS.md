# Referencing your workspace in markdown — the `@`-mention / `eidan:` token

This explains how to **reference (mention) things from your workspace inside any markdown** — chat
prompts, files, board prompts, memory, and agent personas — so a model can be handed the real thing
instead of a name. Use it when authoring agents, prompt specs, and notes.

## The token

A mention is just a **markdown link with the `eidan:` scheme**:

```
[label](eidan:<type>:<id>)
```

- `label` — what's shown (the chip text). Free text; keep `]` and `)` out of it.
- `<type>` — one of: `file` · `folder` · `agent` · `venture` · `asset`
- `<id>` — the entity's id (a uuid for files/folders/agents/assets; the venture id).

Example: `Summarise [Q3 plan](eidan:file:6b1f…-…)` or `Hand this to [CMO](eidan:agent:9a2c…-…)`.

## How to insert one

In **any rich editor** (chat composer, the markdown file editor, board prompt, memory note/knowledge
editors), type **`@`**, search, and pick — the editor inserts the correct token (you never type the id
by hand). The picker is powered by `GET /api/mentions/search?q=<text>[&types=file,agent,…]`, which
returns `{ type, id, label, hint }` for files, folders, agents, ventures and assets you own.

You can also **write the token by hand** if you already have the id.

## What it does — and WHERE (read this before building agents)

1. **Rendering** — everywhere markdown is shown (chat, file viewer, memory), the token renders as an
   inline **chip** (`@label`), not a raw link. Both your prompt bubbles and the assistant's replies
   render it.
2. **Expansion (the important part)** — when a message reaches a **chat turn** (`POST /api/turn`), the
   engine scans it for these tokens and **expands each into real context** for the model, injected
   ephemerally (your message keeps the readable chip):
   - `file` → the file's contents (text files; binary/offloaded → a note to use fs tools)
   - `folder` → a listing of its children
   - `agent` → the agent's name + description + persona
   - `venture` → name + status
   - `asset` → label + kind
   - (Total injection is capped, so a huge file can't blow the context.)

### ⚠️ Caveat for agents (current state)

Expansion currently happens **only in the chat `/api/turn` path** — i.e. when *you* send a message in
chat. It does **not yet** run for:
- **agent turns** (an agent executing its persona), or
- **board prompts** consumed as standing context.

So if you put `[spec](eidan:file:…)` in an **agent persona**, today it will **render as a chip and be
readable**, but it will **not be auto-expanded** into the agent's context at run time. Until
agent-turn resolution ships, prefer one of:
- **Reference + fetch:** mention the file for readability, and tell the agent to `fs_read` it by path
  (e.g. "read `/agents/INDEX.md` first"). This is the reliable pattern for the agent mesh.
- **Inline the essentials** directly in the persona if they're short and stable.

(Wiring the same `eidan:` resolution into the agent runner + board context is a planned follow-up —
once it lands, mentions in personas/prompts expand exactly like they do in chat.)

## Quick reference

| Type | Inserts | Expands to (in chat) |
|---|---|---|
| `file` | `[name](eidan:file:<id>)` | file contents |
| `folder` | `[name](eidan:folder:<id>)` | child listing |
| `agent` | `[name](eidan:agent:<id>)` | name + description + persona |
| `venture` | `[name](eidan:venture:<id>)` | name + status |
| `asset` | `[name](eidan:asset:<id>)` | label + kind |

Parser regex (engine + UI): `\[([^\]]+)\]\(eidan:(file|folder|agent|venture|asset):([^)\s]+)\)`

## Not the same as "tags/labels"

Don't confuse this with **tagging** (organising/filtering): conversations + files carry
`metadata.tags` (a label you bulk-apply in the Select bar to filter lists), and board *cards* carry
`metadata.labels` (coloured chips). Those are for **organising**; the `eidan:` token here is for
**referencing/handing over** an entity inside prose. (See CHANGELOG 0.13.4 / 0.13.9 for tagging.)
