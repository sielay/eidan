# 014 — Minimal UI surface

Status: Draft
Owner: Core
Related: `docs/ARCHITECTURE.md` (Stack, Agentic loop, Token tracking),
`docs/001_PLUGINS.md` (§1.1 manifest `frontend:`, §3 frontend mounting,
§3.1 component contract, §5 behaviours),
`docs/003_MEMORY_DDL.md` (§3 messages, §4 events, §5 knowledge,
§6 notes, §7 agent_context),
`docs/004_SCHEMAS.md` (§2.6 cross-boundary schemas, `agentic/*` DTOs),
`docs/005_AGENTIC_LOOP.md` (§2 layers, §5.5 primary loop,
§5.9 synthesis bundle, §6.5 user-facing errors),
`docs/006_BEHAVIOURS_TRIGGERS.md` (§7.2 OFFER mode, §7.4 persistence,
§8.5 chip flood cap),
`docs/010_COST_BUDGETING.md` (§6 UI counter hooks,
§6.1 `TurnCost`, §6.3 session and rolling-day counters),
`docs/011_AUTH_FLOW.md` (§3 frontend login flow,
§3.4 `/api/auth/config`, §3.5 per-request token),
`docs/012_SECRETS.md` (§4.5 operator surfaces, admin UI)

This document specifies the **minimum Next.js UI surface** the host
ships in Phase 1. It pins:

- The screen catalogue — what routes exist, who owns each, and
  which are deferrable beyond Phase 1.
- Where the OFFER affordance (`006 §7.2`) renders inside the
  conversation thread and how accept / dismiss are wired back to
  the backend.
- Where the per-turn and per-session cost counters (`010 §6`)
  live in the layout and how they reconcile with the streaming
  hint vs. the authoritative ledger value.
- The auth screens the host ships, the screens it deliberately
  does **not** ship, and why the asymmetry holds across
  single-user and multi-user (paid baseline bundle) deployments.
- The empty / first-run state — what the operator sees on a
  freshly installed deployment before any conversation or
  plugin exists.
- The mobile / responsive stance for Phase 1: which screens
  are mobile-correct out of the gate and which are explicit
  defers.

The shape is opinionated because the UI is a **thin client over
the backend's authoritative state**. Every visible counter, list,
or chip is derived from a backend payload the relevant spec
already pins (`005 §5.9`, `010 §6`, `006 §7.4`). The frontend
contributes ergonomics, layout, and a Next.js routing tree; it
does not introduce a second source of truth for any
backend-owned datum.

Out of scope (deferred to follow-ups, see §13):

- Visual design tokens (colour palette, type scale, spacing
  grid). The host ships a default that is taste-correct enough
  for self-hosted use; a design-system spec is a follow-up.
- The exact React component library. shadcn/ui + Tailwind is
  the working assumption (it composes with the App Router and
  has minimal runtime cost), but the contract this document
  pins is at the slot/route level, not the component level.
- Internationalisation. The Phase 1 host ships en-GB only;
  i18n primitives are reserved.
- Accessibility certification. The host targets WCAG 2.2 AA on
  the screens this document specifies, but the audit and
  remediation cadence is a follow-up.
- The multi-user admin surface (per-user budgets, per-user
  plugin governance) shipped by the paid baseline bundle.
  Paid plugins inherit this document's contracts and add their
  own screens; they are not pinned here.
- The plugin-install discovery UX (browsing a registry,
  searching plugins). `001 §9` reserves the registry; this
  document inherits the reservation.
- The trace / debugger UI for per-turn drill-downs
  (`005 §9`, `006 §9`). Phase 1 surfaces enough cost and offer
  metadata inline; the deep debugger is a follow-up.

---

## 1. Vocabulary

| Term                  | Meaning                                                                                                                                              |
|-----------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Host UI**           | The Next.js (App Router) application the host ships under `apps/web/`. Single deployable; plugin frontends mount into it (`001 §3`).                  |
| **Screen**            | A top-level route under `apps/web/src/app/`. Each screen below maps onto one route segment.                                                          |
| **Slot**              | A named extension point exposed by the host into which plugins inject components (`001 §3.1`'s `frontend.components[].slot`).                         |
| **OFFER chip**        | The UI affordance that surfaces an OFFER-mode behaviour (`006 §7.2`). Renders inside the assistant message it was attached to.                       |
| **Turn cost chip**    | The small `$0.04` indicator attached to an assistant message. Driven by `TurnCost` (`010 §6.1`).                                                     |
| **Session counter**   | The conversation-scoped cost total rendered in the conversation header. Derived from `010 §6.3`.                                                     |
| **Day counter**       | The user-scoped 24-hour rolling spend rendered in the global header. Derived from `010 §6.3`.                                                        |
| **First-run state**   | The state of the deployment before the operator has held a single conversation. Drives onboarding (§9).                                              |
| **Empty state**       | The state of an *opened but never used* screen — empty memory browser, empty plugin list. Distinct from first-run.                                  |
| **Operator**          | The single human attached to a self-hosted core deployment, identified by `EIDAN_AUTH_ALLOWED_EMAIL` (`011 §3.1`).                                  |
| **Phase 1**           | The release that ships alongside core MVP. Caps which screens this document mandates.                                                                |
| **Mobile-correct**    | Renders and interacts cleanly on a 360 px-wide viewport with no horizontal scroll and tap targets ≥ 40 px. A strict subset of "responsive."          |

---

## 2. The frontend at a glance

```
apps/web/
├── src/
│   ├── app/
│   │   ├── (auth)/                  # auth screens — no nav chrome
│   │   │   ├── login/page.tsx       # §8.1
│   │   │   └── callback/page.tsx    # §8.2 (magic-link / OAuth return)
│   │   │
│   │   ├── (main)/                  # authenticated app — has nav chrome
│   │   │   ├── layout.tsx           # global header (day counter, user menu)
│   │   │   ├── page.tsx             # default landing → /c (latest convo)
│   │   │   ├── c/
│   │   │   │   ├── page.tsx         # empty-state landing if no convos
│   │   │   │   └── [id]/page.tsx    # conversation screen — §4
│   │   │   ├── memory/
│   │   │   │   ├── page.tsx         # memory browser — §5
│   │   │   │   ├── notes/page.tsx
│   │   │   │   ├── events/page.tsx
│   │   │   │   └── knowledge/page.tsx
│   │   │   ├── settings/
│   │   │   │   ├── page.tsx         # settings — §6
│   │   │   │   ├── account/page.tsx
│   │   │   │   ├── providers/page.tsx
│   │   │   │   ├── agents/page.tsx
│   │   │   │   └── budget/page.tsx
│   │   │   ├── plugins/
│   │   │   │   ├── page.tsx         # installed plugins list — §7
│   │   │   │   ├── [name]/page.tsx  # plugin detail
│   │   │   │   └── install/page.tsx # local-path / git install — §7.3
│   │   │   └── p/[plugin]/...       # plugin-mounted routes (001 §3)
│   │   │
│   │   └── onboarding/page.tsx      # first-run only — §9
│   │
│   ├── lib/
│   │   ├── auth.ts                  # native magic-link client (011 §3)
│   │   ├── api/                     # typed fetch wrapper (Authorization: Bearer …)
│   │   └── slots/                   # plugin component slot registry
│   │
│   └── components/
│       ├── conversation/
│       │   ├── Thread.tsx           # message list
│       │   ├── Message.tsx          # one assistant / user / tool row
│       │   ├── OfferChip.tsx        # §4.3
│       │   ├── TurnCostChip.tsx     # §4.4
│       │   └── Composer.tsx
│       ├── memory/
│       └── ...
└── package.json
```

Three load-bearing properties:

- **Two route groups, two layouts.** `(auth)` carries no nav
  chrome, no day counter, no header — by design, the user
  cannot navigate elsewhere without an authenticated session.
  `(main)` carries the global header and side-nav and is
  gated by the middleware in §11.1.
- **The plugin-mounted route prefix is `/p/<name>/...`**, per
  `001 §3`. This document pins the slug; plugins do not
  collide with the host's reserved roots (`c`, `memory`,
  `settings`, `plugins`, `onboarding`).
- **The host owns the conversation, memory, and settings
  screens.** Plugins do not replace them; they may inject
  components into named slots (§10) but the route's owner
  remains the host. This is the inverse of the route mounting
  rule in `001 §3.3` (where the host gives ground to plugin
  routes by namespace) — for core screens, the host always
  owns the page shell.

---

## 3. Screen catalogue

The Phase 1 minimum is the seven screens in the table below.
Anything not listed here is either reserved or owned by a
plugin (Phase 2+).

| Screen              | Route                  | Owner | Phase 1 mandate                  | Notes                                                              |
|---------------------|------------------------|-------|----------------------------------|---------------------------------------------------------------------|
| Login               | `/login`               | Core  | Required                         | Magic-link (email → click-through or paste-back 6-digit code).      |
| Auth callback       | `/login?token=…`       | Core  | Required                         | Receives the magic-link click-through and exchanges via `/api/auth/verify`. |
| Onboarding          | `/onboarding`          | Core  | Required                         | First-run only. Confirms `EIDAN_AUTH_ALLOWED_EMAIL` and exits to `/c`. |
| Conversation        | `/c/[id]`              | Core  | Required                         | The primary surface. See §4.                                        |
| Conversation list   | `/c`                   | Core  | Required (empty-state placeholder ok) | Lists recent conversations; redirects to the latest if any exist. |
| Memory browser      | `/memory/{notes,events,knowledge}` | Core  | Required (read-only ok)          | See §5. Write paths are Phase 2 except for `notes` (mandatory write). |
| Settings            | `/settings/{account,providers,agents,budget}` | Core  | Required                         | See §6.                                                             |
| Plugins (list)      | `/plugins`             | Core  | Required                         | See §7.                                                             |
| Plugins (install)   | `/plugins/install`     | Core  | Required (local path + git)      | See §7.3. Registry browsing is reserved (§13).                      |
| Plugins (detail)    | `/plugins/[name]`      | Core  | Required                         | Per-plugin status, env, vault, behaviours.                          |
| Admin (MCP)         | `/admin/mcp`           | Core  | Required (read-only ok)          | The §9.2 panel from `013`. Inherited verbatim.                      |
| Plugin-mounted      | `/p/<name>/...`        | Plugin| Optional                         | Plugin's own routes (`001 §3`).                                     |
| Signup              | (none)                 | —     | **Not shipped**                  | §8.4.                                                               |
| Password reset      | (none)                 | —     | **Not shipped**                  | Magic-link sign-in has no password to reset.                        |

The seven required core screens are the floor. A deployment
that omits any of them is a configuration error; the host's
build refuses to start with a missing screen.

---

## 4. Conversation screen

`/c/[id]` is the primary surface and the screen this document
specifies in the most detail. Everything else is either chrome
around it or a side-channel for managing what it can do.

### 4.1 Layout

```
┌────────────────────────────────────────────────────────────────┐
│  global header                                                 │
│  ┌───────────┐                            ┌─────────────────┐  │
│  │ ☰ side    │ conversation title         │ day: $0.42 / $5 │  │
│  └───────────┘                            └─────────────────┘  │
├────────────────────────────────────────────────────────────────┤
│  conversation header                                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Agent: Default                  session: $0.04 / $10.00  │  │
│  └──────────────────────────────────────────────────────────┘  │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│   ┌── user ─────────────────────────────────────┐              │
│   │ morning! quick — what do my notes say about │              │
│   │ the dentist?                                │              │
│   └─────────────────────────────────────────────┘              │
│                                                                │
│   ┌── assistant ────────────────────────────────┐              │
│   │ Your last dentist note (2 weeks ago) says…  │              │
│   │                                             │              │
│   │ ┌── offer (006 §7.2) ──────────────────────┐ │              │
│   │ │ Summarise today's notes?                 │ │              │
│   │ │ [ Yes ]   [ Dismiss ]                    │ │              │
│   │ └──────────────────────────────────────────┘ │              │
│   │                                             │              │
│   │ $0.04 ▸ 1.2k in · 320 out · cache 89%       │              │
│   └─────────────────────────────────────────────┘              │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│  composer                                                      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Reply...                                          [Send] │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

The three vertical bands are non-negotiable for Phase 1:

- **Global header** carries the day counter (§4.4) and the
  user menu. Same on every `(main)` screen.
- **Conversation header** carries the per-conversation
  metadata: the active agent's display name, the session
  counter (§4.4), and a soft-cap badge when the conversation
  enters wrap-up.
- **Thread** is the message list. Composer is pinned to the
  bottom; the thread auto-scrolls to the latest assistant
  message at synthesis end.

### 4.2 Message rendering

The thread renders three roles end-to-end: `user`, `assistant`,
and (collapsed by default) `tool`. The mapping to
`eidan.messages` (`003 §3`) is one row → one rendered block,
except:

- Consecutive `tool` rows are folded into a single "tool work"
  disclosure under the assistant message that issued them.
  The disclosure is closed by default and shows
  "N tool calls" with a chevron. This matches the synthesis
  bundle (`005 §5.9`) shape: the user cares about the final
  assistant text, not the intermediate tool ping-pong.
- `metadata.failure` markers (`005 §6.5`) render as an inline
  red row under the offending assistant message, with the
  user-facing error string and a "retry" button when the
  failure class is retryable (`007 §8.1`).

The thread is **streamed**, not request/response. Per `011
§3.5` the host opens a WebSocket with the bearer token in the
sub-protocol; SSE is the in-process choice for the host's MCP
server (`013 §3.2`), but the browser connects over WS for the
primary UI because:

- The bearer-in-sub-protocol pattern (`011 §3.5`) is already
  required for the budget push channel.
- WS gives a bidirectional channel for the offer-dismiss case
  (§4.3) without a second HTTP call.

### 4.3 OFFER affordance

Per `006 §7.2`, an OFFER chip is surfaced when the synthesis
bundle carries `metadata.offers[]` on the assistant message.
The UI's job is to render the chips, accept the user's choice,
and route the choice back into the same turn pipeline (`006 §7.2`
explicitly: an offer accept is a follow-up user message with
`metadata.confirms_offer = <behaviour_id>`).

**Position.** The chip(s) render **inside the assistant message
they were attached to**, *below* the message body and *above*
the turn-cost chip. Three reasons:

- **Locality.** The chip is a continuation of the assistant's
  reasoning, not a standalone widget. Visually attaching it to
  the message answers "whose offer is this?" without a label.
- **Eviction.** When the next turn lands, the offer chip
  dismisses if not accepted (`006 §7.2`). Anchoring the chip
  to the message means the "previous turn" naturally falls
  out of focus alongside the chip — no detached banner left
  hanging.
- **Order.** Multiple chips on one message stack vertically
  in the order the backend listed them (the backend already
  ordered by behaviour `priority` in `006 §8.5`). The UI
  preserves order and does not re-rank.

**Shape.** Each chip is one row:

```
┌── Summarise today's notes? ──────────────────────┐
│ [ Yes ]   [ Dismiss ]                            │
└──────────────────────────────────────────────────┘
```

The label is the behaviour's `display_label` field (a new field
on the synthesised offer payload, populated from the manifest
or — when absent — the `display_name` of the contributing
plugin plus the behaviour's `id` tail).

**Accept.** Clicking `Yes` immediately submits a follow-up
turn whose user message body is the chip's `display_label` (so
the conversation log reads naturally on replay) and whose
`metadata.confirms_offer` is set to the behaviour `id`. The
runner intercepts at step ② per `006 §7.2` and fires the
handler directly — the UI does not need to know this; it just
sees the assistant message that results.

**Dismiss.** Clicking `Dismiss` is **purely client-side**: the
chip vanishes from the rendered state, and the next turn's
synthesis bundle (which will not carry the offer again, per
`006 §7.2`'s "chip disappears at next turn") confirms the
dismissal in persistence. No HTTP call is made for dismissal —
the dismissal lives in the assistant message's metadata as the
absence of acceptance, which is what `006 §7.4` already
records.

**Implicit dismissal.** Sending any reply that is not an
acceptance also dismisses the chip. The UI guarantees this by
clearing pending offer chips from local state on `composer
submit`. The backend's view is consistent: the previous turn's
`metadata.offers[]` is preserved on its row, but the next
turn's synthesis bundle is the new authority.

**Cap.** Per `006 §8.5` the backend caps visible chips at 3 by
default. The UI does not impose its own cap; it renders what
the backend hands it. If the cap is raised by an operator,
the UI accommodates without a release.

**Persistence and read-back.** When a thread is loaded from
history, each assistant message renders its
`metadata.offers[]` exactly as it did at synthesis, **except**
that any offer whose behaviour `id` is recorded as accepted by
a *later* message (`metadata.from_offer = <id>` on a subsequent
assistant row per `006 §7.4`) is rendered greyed out with a
small "accepted" tick — the user sees what happened without
the option to re-trigger. Offers neither accepted nor
followed by another turn render as "dismissed" with the same
greyed style.

### 4.4 Cost counter placement

`010 §6` pins three counters; this section pins **where each
one lives in the layout**, **what payload feeds it**, and
**how it updates** during a turn.

| Counter         | Position                                        | Source payload                              | Update path                                                                                       |
|-----------------|--------------------------------------------------|----------------------------------------------|----------------------------------------------------------------------------------------------------|
| **Turn cost**   | Inline under each assistant message              | `TurnCost` in the synthesis bundle (`010 §6.1`) | Replaces a streaming hint on synthesis. See §4.4.1.                                                |
| **Session**    | Conversation header, right-aligned, format `$X / $cap` | `GET /api/budget/session` (`010 §6.4`)        | Re-fetched on every turn's synthesis end; receives WS push when a background subagent commits.    |
| **Day**         | Global header, right-aligned, format `day: $X / $cap`  | `GET /api/budget/session` ∪ same WS push      | Same as session. Colour-coded per `010 §6.3` thresholds.                                          |

#### 4.4.1 The turn cost chip

During the primary call's stream, the UI shows a streaming
hint:

```
… 320 tokens in · 84 streaming …
```

The hint is local: input tokens come from the pre-call
estimate the backend sent at stream open, output tokens are
counted from the streamed content length per `010 §6.2`.
**The hint never claims a dollar value.** Showing a partial
cost mid-stream is misleading — providers do not bill until
the call closes, and the estimate would jitter.

On `message_stop` the synthesis bundle arrives and the hint
is **replaced** by the authoritative chip:

```
$0.04 ▸ 1.2k in · 320 out · cache 89%
```

The chip is keyed by `TurnCost.cap_state.kind`:

- `ok` — neutral chip, default colour.
- `wrap_up` — yellow chip, with a hover tooltip explaining
  the per-turn soft cap (`010 §4.1`).
- `denied` — red chip, with the deny `reason` inlined. The
  assistant message body is the system-emitted explanation
  (`005 §6.5`); the chip is the affordance to a "what
  happened" tooltip.

The cache-hit fraction (`cache_read_tokens / (input_tokens +
cache_read_tokens)`, per `010 §7.1`) is a Phase-1-nice
addition that confirms caching is working in production. It is
omitted when the denominator is zero.

#### 4.4.2 The session counter

The conversation header carries a small text chip:

```
session: $0.04 / $10.00
```

`$10.00` is the resolved `per_conversation_usd` cap for this
conversation (`010 §4.6`). When the cap is `null` (no cap), the
chip degrades to `session: $0.04`.

The colour-coding mirrors the day counter (`010 §6.3`):
neutral ≤ 80%, warning 80–100%, error > 100% (the
conversation has been denied a further call).

#### 4.4.3 The day counter

The global header carries the same shape, scoped to the user's
rolling 24-hour window:

```
day: $0.42 / $5.00
```

The day counter is the **single piece of user-scoped budget
information** the UI ever surfaces above the conversation
header. Per-user analytics — period-over-period drift,
per-model breakdowns — belong to the paid baseline bundle's
analytics plugin (`010 §7`) and live behind a plugin route,
not in the host's chrome. This keeps the host's header free
of clutter and keeps the host's screen catalogue small.

### 4.5 Composer

The composer is a single textarea with a `Send` button. Three
properties:

- **Submit on `Enter`, newline on `Shift+Enter`.** This is the
  modern chat-app default; the host adopts it without a
  preference.
- **Disabled while a turn is in flight.** The UI knows a turn
  is in flight because the WS stream is open. Disabling
  prevents double-submission; the backend's idempotency key
  (a future spec) is the belt; this is the braces.
- **Auto-grows up to 30% of the viewport height**, then
  scrolls internally. The user can paste a long block without
  the composer pushing the thread off-screen.

The composer does **not** ship a file/attachment affordance in
Phase 1. Memory writes (notes, knowledge) happen in the memory
browser (§5); a turn-attached upload primitive is reserved.

### 4.6 Wrap-up and denial rendering

When a turn enters wrap-up (`010 §4.1` soft cap), the assistant
message renders normally with a `wrap_up` turn cost chip
(§4.4.1) and a single-line banner below the chip:

```
⚠ Per-turn budget hit — summarising with what I have so far.
```

The banner is dismissible per-message (UI state only); the
backend's `cap_state.reason` field stays on the message for
audit.

When a turn is denied (`010 §5.4`), the assistant message body
is the system-emitted explanation already produced by the
runner. The UI does **not** add a second banner. The denial
chip's tooltip (§4.4.1) is the only UI-added artefact.

---

## 5. Memory browser

The memory browser surfaces the three primary user-visible
tables in `003`: `notes` (`§6`), `events` (`§4`), and
`knowledge` (`§5`). The conversation table (`messages`,
`conversations`) is not surfaced here — conversations live on
the conversation screen and the side-nav, not in the memory
browser. This is a deliberate split: the memory browser is for
durable, addressable artefacts; the conversation list is for
turn-by-turn dialogue history.

### 5.1 Notes (`/memory/notes`)

Phase 1: read **and write**.

- **List view.** Paginated table sorted by `created_at` DESC.
  Columns: title (the note's first 80 chars when no
  `metadata.title` is set), agent, created_at, source.
- **Detail view.** Markdown rendering of `body`. Edit-in-place
  for the operator's own notes (or any note when in single-user
  core). Edits write a new row, never overwrite, per `003 §6`'s
  append-only discipline.
- **New note.** A `+ New` button opens the markdown editor.
  `agent_id` defaults to the operator's primary agent; `source`
  defaults to `manual_ui`.

Notes are the only memory table the operator routinely **writes
by hand**. Knowledge and events accumulate from agentic
behaviour; manual entry is rare. This justifies notes' Phase 1
write mandate.

### 5.2 Events (`/memory/events`)

Phase 1: read-only.

- **List view.** Filter by `status` (default: `pending` +
  `due` + `today`). Sort by `due_at` or `occurred_at`.
- **Detail view.** Renders the event row plus a "completed
  by" badge when applicable.

Write-by-hand happens through the conversation ("remind me
tomorrow at 9"), not through the UI. A "+ New event" affordance
is reserved for Phase 2 once the calendar-shape ergonomics are
clearer.

### 5.3 Knowledge (`/memory/knowledge`)

Phase 1: read-only.

- **List view.** Grouped by `skill`; titles listed under each
  group. Search box hits `eidan.memory.search` (`013 §3.4`).
- **Detail view.** Markdown rendering of `body`.

Knowledge is curated by the agent, not the user. A manual
"edit knowledge" affordance is reserved for Phase 2; the
read-only Phase 1 shape is enough to verify what the agent
believes.

### 5.4 Cross-screen invariants

- **One pagination shape.** All three list views use
  cursor-based pagination over a `created_at` index. No
  offset/page combo; offset pagination breaks under concurrent
  writes and these tables grow.
- **Soft-deleted rows are hidden by default.** A `Show deleted`
  toggle reveals them; deletion is a soft-delete on the
  underlying table (`003 §3`'s `deleted_at` convention applies).
- **No bulk operations in Phase 1.** Bulk delete, bulk tag,
  bulk export — all reserved. The single-user host has small
  enough memory volumes that single-row operations are
  sufficient for the foreseeable.

---

## 6. Settings

Four sub-screens, each addressable by direct URL.

### 6.1 Account (`/settings/account`)

The only user-scoped settings the host owns. Three controls:

- Display name (writes through to `eidan.users.display_name`).
- Email (read-only mirror of the row's email — set at first
  magic-link claim).
- Sign-out button.

MFA enrolment lives in §6.5 once the scaffold ships in core. The
host does not run a password-change flow — magic-link sign-in has
no password to change.

### 6.2 Providers (`/settings/providers`)

Per-provider configuration matching `007`'s adapter model:

- **List view.** One row per registered provider (Anthropic,
  OpenAI, llama.cpp, …). Status (configured / unconfigured)
  drawn from the env-key presence check.
- **Per-provider panel.** API key entry (writes through the
  vault per `012 §6` with a "last rotated" hint per `012 §10`);
  selected default model for the provider's tier.

The API key entry field is a one-way write: the field renders
masked once set and never reveals the value back. Editing
requires re-entry.

### 6.3 Agents (`/settings/agents`)

The agent registry, surfacing `agent_context` (`003 §7`):

- **List view.** All registered agents with their display
  names and the `user_overrides.budget` summary.
- **Per-agent panel.** Display name, primary system prompt
  (read-only summary; full editing is Phase 2 once the
  prompt-versioning story is clear), per-agent budget
  overrides (`010 §4.6`), and a "set as default" toggle.

The primary agent is the one new conversations attach to by
default. Switching primary is a single click.

### 6.4 Budget (`/settings/budget`)

The host-level budget config (`010 §4.6`):

- Per-turn soft cap and hard factor.
- Per-conversation cap.
- Per-day cap.
- Per-agent monthly cap (default off).
- The wrap-up addendum text (free text; rendered with a
  "you are over the per-turn budget — wrap up" example
  preview).

Per-user budgets (`010 §4.4`) appear here only when the
paid budgets plugin is installed; the screen reads
`/api/budget/config?scope=user&user_id=<...>` and degrades
when the endpoint returns 404 (core-only deployments).

---

## 7. Plugins

### 7.1 Installed list (`/plugins`)

Table of every loaded plugin: name, version, tier, status
(active / inactive / failed), behaviours count, MCP server
status (per `013 §9.2`). The list is keyed on the manifest's
`name`; the row links to `/plugins/[name]`.

### 7.2 Plugin detail (`/plugins/[name]`)

Three tabs:

- **Overview.** Manifest summary (display name, description,
  authors, license), declared env (`001 §1.1`) with set/unset
  state per variable, declared vault keys (`012 §6.2`) with
  per-key set/unset state.
- **Behaviours.** Each behaviour the plugin contributes,
  showing `id`, mode (AUTO / OFFER), priority, and matched-
  intent-trigger sentences (`006 §2.1`). The runner's
  `behaviours_loaded` audit (`006 §9`) is surfaced as a
  recent-fires panel.
- **Routes.** The frontend routes the plugin mounts (its
  `frontend.routes[]` from `001 §1.1`), each linked.

The detail screen is where the operator configures a plugin's
env and vault entries. Writes route through the vault accessor
(`012 §5`) and are subject to the `actor_kind = admin` audit
flag (`012 §8.1`).

### 7.3 Install (`/plugins/install`)

Phase 1 install paths:

- **Local path.** Operator types or pastes a filesystem path
  to a plugin directory. The host runs `001 §8`'s install
  protocol verbatim. The form shows the manifest pre-flight
  output (validation errors, dependency check, manifest
  summary) before commit.
- **Git URL.** Same flow over a `git clone`. Optional `ref`
  (tag, branch, commit). Same pre-flight before commit.

Browsing a registry is **deferred** (`001 §9`); the page shows
a "Browse the registry" CTA that links to a static index page
when an operator has configured one, otherwise it renders the
two install paths only.

### 7.4 Plugin route mounting

A plugin's own routes mount under `/p/<name>/...` per `001 §3`.
The host's sidebar surfaces them under a "Plugins" group
keyed on the plugin's `display_name`; each route's nav label
is the `frontend.routes[].label` (a new manifest field — see
§14).

---

## 8. Auth screens

The host ships exactly two auth screens. The asymmetry — login
yes, signup no — is deliberate.

### 8.1 Login (`/login`)

The login form renders the surfaces enabled by
`/api/auth/config` (`011 §3.5`). Today there is one block:

- **Magic link.** Email field (pre-filled from
  `allowed_email`), "send magic link" button. After submit, a
  6-digit-code paste-back input appears so the operator can
  finish the flow without leaving the page if their mail
  client is awkward.

When the user clicks the link in their email, the browser lands
on `/login?token=<opaque>`. The page exchanges it via
`POST /api/auth/verify` and redirects to `/c` on success.

The form's only branding is the literal "Eidan". OAuth provider
blocks are reserved for the day a second `AuthProvider` lands
(`011 §9`).

### 8.2 Sign-out

Not a screen — a button in the user menu (§4.1). Click →
`POST /api/auth/logout` → drop the in-memory access token →
redirect to `/login`. No confirmation modal; sign-out is
reversible.

### 8.3 Why no signup screen

Core is a **single-operator** install. `EIDAN_AUTH_ALLOWED_EMAIL`
is the only address that can mint a magic link; a signup form
would either be unreachable (because the email wouldn't be on the
allow-list) or a phishing surface. Multi-user deployments need a
different shape entirely (invite-only with role assignment) and
that screen ships with the universal paid baseline bundle.

### 8.4 Anonymous mode

Not exposed. `011 §2` is explicit: every request needs a valid
access token. A request without one is redirected to `/login`,
full stop.

---

## 9. First-run state

A freshly installed deployment has zero conversations, zero
notes, zero events, and zero non-core plugins. The UI's
first-run flow is one screen.

### 9.1 `/onboarding`

Mandatory on first load when:

- The operator's user row exists in `eidan.users` (created on the
  first magic-link claim for `EIDAN_AUTH_ALLOWED_EMAIL`).
- No conversation exists (`COUNT(*) FROM eidan.conversations
  WHERE user_id = $operator = 0`).
- `eidan.agent_context` carries no rows for the operator.

The screen presents a single-column wizard:

1. **Welcome.** One paragraph naming the deployment (from
   `/api/auth/config`) and the operator's email.
2. **Pick a provider.** One field: paste an API key for the
   default provider (`007`'s adapter the operator wants).
   The host writes through the vault, validates with one
   tiny `count_input_tokens` round-trip, and reports back.
3. **Pick a primary agent.** Defaults: "Default" agent with
   the host's stock system prompt. The operator can rename
   it or pick a different stock prompt from a small fixed
   list. Free-form prompt entry is Phase 2.
4. **Done.** A single "Start a conversation" button creates
   a fresh conversation row and redirects to `/c/<id>`.

The wizard writes through the same backend endpoints
(`/api/providers`, `/api/agents`) that `/settings/*` uses; it
is not a privileged path.

### 9.2 Skipping onboarding

The wizard is **mandatory**, not skippable, in Phase 1. The
host needs at least one provider key to issue a turn, and the
runner refuses to start without an agent context row for the
operator. An operator who tries to navigate away from
`/onboarding` is redirected back; the only escape is
finishing the four steps or signing out.

This is opinionated. The alternative — a "skip for now" link —
results in a half-configured install that crashes on the first
turn submission with an error the operator does not yet have
the mental model to debug. Better to front-load the cost.

### 9.3 Empty state vs first-run state

| State        | Trigger                                | UI shape                                                                                  |
|--------------|----------------------------------------|--------------------------------------------------------------------------------------------|
| First-run    | No conversation + no agent_context     | Forced redirect to `/onboarding`. See §9.1.                                                |
| Empty `/c`   | At least one agent_context, zero convos| `/c/page.tsx` shows a centred "Start a conversation" CTA + recent OFFER chips from cron-triggered behaviours (`006 §5.1`'s cron triggers) if any are pending. |
| Empty memory | Authenticated, no notes / events / kb  | Each `/memory/*` screen renders a one-line "Nothing here yet — when the agent or you create one, it will appear." No CTA on knowledge / events; a single "+ New note" on `/memory/notes`. |
| Empty plugins | No installed plugins beyond core      | `/plugins` shows the core plugins (host-bundled) with status `active`; an `Install your first plugin` CTA links to `/plugins/install`. |

The four are distinct: first-run is a configuration gap,
empties are normal post-configuration steady states.

---

## 10. Component slot catalogue

`001 §3.1` introduced named slots for plugin component
contribution. This document pins the **stable Phase 1
catalogue**:

| Slot name                      | Where it renders                                                                  | Plugin payload shape                                          |
|--------------------------------|-----------------------------------------------------------------------------------|----------------------------------------------------------------|
| `dashboard.widget`             | Reserved for Phase 2 (there is no dashboard screen in Phase 1).                  | n/a — declared, not rendered.                                  |
| `conversation.message.below`   | Below an assistant message body, above the turn-cost chip.                       | `{ message: Message }` — the assistant message DTO.            |
| `conversation.composer.action` | A small icon button row inside the composer's left edge.                         | `{ conversationId: string }`.                                  |
| `memory.notes.row.action`      | Per-row action menu on `/memory/notes` list.                                     | `{ note: Note }`.                                              |
| `settings.section`             | A full section under `/settings` (renders as a new sub-page in the sidebar).     | none (the component owns its own data fetching).               |
| `plugin.detail.tab`            | An additional tab on `/plugins/[name]`.                                          | `{ pluginName: string }`.                                      |
| `command-palette.action`       | Reserved for Phase 2 (there is no command palette in Phase 1).                   | n/a — declared, not rendered.                                  |

Phase 1 ships the five non-reserved slots. The two reserved
slots are declared so plugins targeting Phase 2 can include
them in their manifests without breaking Phase 1 validation;
the host warns at load time when an installed plugin uses a
reserved slot but does not refuse.

The component contract (`001 §3.1`) applies to every slot:
default export, `PluginProps<T>` shape, tree-shakable.

---

## 11. Routing, data fetching, and auth integration

### 11.1 Middleware-level auth

`apps/web/src/middleware.ts` runs before any `(main)` route:

```ts
// apps/web/src/middleware.ts — sketch
import { NextResponse, type NextRequest } from "next/server";
export async function middleware(req: NextRequest) {
  const refresh = req.cookies.get("eidan_refresh");
  if (!refresh && !req.nextUrl.pathname.startsWith("/login")) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next|api|favicon).*)"],
};
```

The matcher excludes `/_next`, `/api`, and static assets.
Per `011 §2`'s rule — Eidan itself is the only issuer of
identity — the middleware never validates the JWT itself; it
checks for the refresh-cookie's presence. The Python backend is
the authority on token validity (`011 §5`), and a stale browser
session that the middleware lets through is rejected by the
backend on the first authenticated fetch.

### 11.2 Server vs client components

The screen catalogue uses the App Router's default split:

- **Server components by default.** All screen `page.tsx`
  files server-render the initial state — the refresh cookie
  is read from `cookies()` and exchanged via
  `POST /api/auth/refresh` to mint a fresh access token for
  the first server-side fetch.
- **Client components for interaction.** The composer,
  OFFER chip, message stream, and every form widget are
  client components. They use the `lib/api/` typed fetch
  wrapper to talk to the Python backend.

Streaming the conversation thread itself happens **client-side
over WS** (§4.2). The server-rendered initial state is the
*history* up to the moment the page loaded; the WS picks up
mid-stream if a turn is in flight when the page mounts.

### 11.3 The typed fetch wrapper

`apps/web/src/lib/api/client.ts` is one file:

```ts
// apps/web/src/lib/api/client.ts — sketch
import { authFetch } from "@/lib/auth";

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await authFetch(path, init);
  if (!res.ok) throw await toErrorShape(res); // §12
  return res.json() as Promise<T>;
}
```

`authFetch` (in `apps/web/src/lib/auth.ts`) attaches the
in-memory access token, refreshes on `auth.token_expired` via the
httpOnly refresh cookie, and surfaces the typed error envelope
from `011 §10.1`.

Every screen's data fetch goes through it. Per-route DTOs
land under `apps/web/src/lib/api/types.ts`, generated from
`packages/schemas/` per `004 §3.2`. No screen authors its own
DTO shape by hand.

### 11.4 Plugin frontend integration

Plugins ship their UI as an npm-style package per `001 §3`.
The host's build symlinks each plugin's `web/` into
`apps/web/src/plugins/<name>/` and a generated barrel file
re-exports their routes and components for the App Router and
the slot registry. Per `001 §3.2` the host runs `pnpm install
&& pnpm build` at install time; the generated barrel ensures
the runtime can resolve plugin imports without a separate
build step per plugin.

---

## 12. Error states

The UI surfaces three error classes the user can act on, all
reusing `011 §10`'s wire shape verbatim.

| Class         | Wire `code` prefix         | UI shape                                                                                                              |
|---------------|-----------------------------|-----------------------------------------------------------------------------------------------------------------------|
| Auth          | `auth.*` (`011 §10.2`)      | Redirect to `/login?error=<code>`; the login screen renders the message above the form.                              |
| Budget        | `budget.*` (a future code; today emitted as the system message body) | Rendered as the denied turn cost chip + system message (§4.6). No global toast.            |
| Upstream      | `mcp.upstream_unavailable`, `provider.*` | Inline red row under the offending assistant message; "Retry" button when the typed error is retryable (`007 §8.1`).  |

Generic 4xx / 5xx that does not match the table above renders
as a global toast: short title + the `code` + the `request_id`.
The `request_id` is selectable (one click to copy) — this is
the canonical handle the operator pastes into a bug report.

The UI does **not** poll, retry on its own, or implement an
offline queue. A failed write is a failed write; the user
re-submits. Background reconciliation is a deliberate
non-feature in Phase 1 because the alternative — silently
re-trying a write — masks bugs the host wants to see surface.

---

## 13. Mobile / responsive stance

Phase 1 is **desktop-first**, with one explicit exception.

### 13.1 What is mobile-correct in Phase 1

| Screen                  | Mobile-correct in Phase 1?  | Notes                                                                                  |
|-------------------------|-----------------------------|----------------------------------------------------------------------------------------|
| `/login`, `/callback`   | Yes                         | Trivial single-column forms; no special work needed.                                   |
| `/onboarding`           | Yes                         | Same shape as login.                                                                   |
| `/c/[id]`               | **Yes**                     | The conversation screen is the one screen the operator uses on a phone.                |
| `/c`                    | Yes                         | List view; trivial.                                                                    |
| `/memory/*`             | Reflow only — no redesign   | Tables become stacked rows below 640 px. Functional, not pretty.                       |
| `/settings/*`           | Reflow only — no redesign   | Same shape.                                                                            |
| `/plugins/*`            | **Defer**                   | Plugin install on a phone is not a real use case. The screen renders but is not tuned. |
| `/admin/mcp`            | **Defer**                   | Operator-only screen; landscape desktop is the working assumption.                     |
| Plugin-mounted (`/p/`)  | Defer to plugin             | Plugin authors decide; the host's chrome reflows correctly underneath.                 |

The asymmetry is deliberate: the conversation screen is
where mobile usage actually happens (operator on the move,
checking a memory, dictating a note); the admin surfaces are
not. Forcing mobile-correctness on admin screens in Phase 1
would inflate scope without buying any real user value.

### 13.2 What "mobile-correct" means for `/c/[id]`

- 360 px viewport renders without horizontal scroll.
- The conversation header collapses to a single line with the
  session counter as a small chip and the agent name truncated.
- The composer pins to the bottom and respects the iOS
  keyboard inset.
- OFFER chips wrap to two lines when the label exceeds the
  available width; `Yes` / `Dismiss` buttons stay full-width
  tappable (≥ 40 px).
- The turn-cost chip's token breakdown collapses to the dollar
  value only; the breakdown is revealed on tap.

### 13.3 What is explicitly deferred

- Native mobile apps (iOS, Android). The PWA shape the host
  ships is enough; native is a separate product.
- Push notifications. The day counter and the OFFER chip are
  enough situational awareness for Phase 1; the architecture
  for push is a follow-up spec on top of the WS budget push
  channel (`010 §6.3`).
- Mobile-tuned plugin install / admin / MCP screens. These
  ship desktop-first and reflow only.
- A dedicated tablet shape. Tablet renders the desktop layout;
  no two-pane redesign is in scope for Phase 1.

The reservation is explicit so a reader does not infer Phase 1
omissions as bugs.

---

## 14. Migration impact on existing specs

This document references but does not change:

- **`001 §3`.** Plugin frontend mounting works as specified.
  This document pins the slot names a Phase 1 host honours
  (§10) and the route prefix (`/p/<name>/...`).
- **`005 §5.9`.** The synthesis bundle is the source of the
  `TurnCost` and `offers[]` payloads. No change to the
  bundle's contract.
- **`006 §7`.** The OFFER mode's confirmation path
  (`metadata.confirms_offer`) is consumed by the UI; this
  document pins how the consumption looks on screen.
- **`010 §6`.** The counter hooks defined there are the
  data source for §4.4; the placements pinned here do not
  alter the hooks.
- **`011 §3`.** The frontend login flow specified there is
  the source for §8.1 and §8.2; this document adds layout
  detail, not protocol change.
- **`013 §9.2`.** The `/admin/mcp` panel ships verbatim per
  `013`.

This document does change:

- **`001 §1.1`.** Two additive manifest fields are introduced:
  - `frontend.routes[].label`: human-friendly label for
    sidebar rendering (§7.4). When absent, the host falls
    back to the last path segment.
  - `behaviours[].display_label` (when the behaviour declares
    an OFFER trigger): the label rendered on the OFFER chip
    (§4.3). When absent, the host synthesises one from the
    plugin's `display_name` and the behaviour's `id` tail.

  Both fields are additive — existing manifests load as before.

- **`011 §3.4`.** A `display_name` field is added to the
  `/api/auth/config` response (§8.1). Existing clients that
  ignore unknown fields are unaffected.

The follow-up PR list (filed against issues yet to be opened):

- Update `PluginManifest.schema.json` with
  `frontend.routes[].label` and `behaviours[].display_label`.
- Update `004 §8`'s generated DTOs for `TurnCost.cap_state`
  and the new offer payload fields (`display_label`).
- Add a `display_name` field to `/api/auth/config`.
- Bundle the Phase 1 slot catalogue (§10) into the host's
  startup validation: a manifest referencing an unknown slot
  fails to install with a clear error.

---

## 15. Reserved for later specs

Deliberately out of scope, to be specified in follow-ups:

- **Design system.** Tokens, type scale, component library
  selection — a follow-up.
- **Trace / debugger UI** for per-turn drill-downs (`005 §9`,
  `006 §9`). Phase 1 surfaces enough inline; the deep
  debugger is its own surface.
- **Command palette.** The slot is declared (§10) but the
  surface itself is reserved.
- **Dashboard screen.** A landing page with widgets across
  conversations, notes, and pending events. Reserved.
- **Plugin registry browser.** `001 §9` reserves the
  registry; the UI inherits.
- **Knowledge / events write paths.** Read-only in Phase 1
  per §5; write is Phase 2.
- **Bulk operations on memory.** Bulk delete / tag / export.
- **Native mobile apps and push notifications.**
- **i18n.** Phase 1 is en-GB only.
- **A second-user invite flow on core.** Multi-user core is
  not a product shape; the paid baseline bundle ships its own.
- **Custom theming.** The host ships one theme; per-user
  theming is reserved.
- **Offline / PWA install affordance.** The Next.js app is
  served as a PWA-shaped app but does not ship a manifest
  prompt for `Add to home screen` in Phase 1.
