// SPDX-License-Identifier: AGPL-3.0-or-later
// The content-workflow abstraction. A WorkflowDef is DATA the engine runs; the workflows themselves
// ship as hardcoded config (see ./workflows), grown by adding config objects + a PR — like
// CORE_PLUGINS / DEFAULT_PROVIDERS. A stage is either a deterministic tool or a bounded, iterative
// mini-chat; advancing a column freezes the stage's output into the card's `writes` slot.

export type Channel = 'linkedin' | 'threads' | 'x' | 'newsletter' | 'blog';
export type Format = 'carousel' | 'video' | 'post' | 'article';

// The named slots a stage reads from / writes to on the card. The card is the durable state; each
// stage reads only the slots it needs (bounded context) and promotes one slot on exit.
export type CardSlot = 'brief' | 'concept' | 'prompts' | 'assets' | 'copy';

// Who signs off the column move. Default 'user' — the agent proposes, you approve.
export type Gate = 'auto' | 'user' | 'agent';

export type StageAction =
  // Deterministic — no LLM. `tool` is an eidan tool the stage runs (e.g. image_generate, schedule).
  | { type: 'tool'; tool: string; params?: Record<string, unknown> }
  // A bounded, iterative mini-chat scoped to this stage: `basePrompt` (shipped) + brand kit + card
  // context. `skills` are loaded first; `reads`/`writes` are the card slots. Model omitted ⇒ turn default.
  | { type: 'chat'; model?: string; basePrompt: string; skills?: string[]; reads: CardSlot[]; writes: CardSlot };

export interface StageDef {
  id: string;
  label: string;
  gate: Gate;
  action: StageAction;
}

export interface WorkflowDef {
  id: string;
  label: string;
  appliesTo: { formats: Format[]; targets: Channel[] };
  stages: StageDef[];
}
