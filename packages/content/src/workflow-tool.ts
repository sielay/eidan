// SPDX-License-Identifier: AGPL-3.0-or-later
// content_workflow — expose the shipped workflows and compose a stage's grounded prompt. The prompt a
// bounded stage-chat runs is composeStagePrompt(stage.basePrompt [shipped] + brand kit [data] + card
// context [data]) — that layering is the anti-drift, anti-hallucination core.
import type { JSONSchema, Tool } from '@matatbread/matbot-plugin-api';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';

import type { ContentDb } from './db.js';
import type { StageDef, WorkflowDef } from './workflow-types.js';
import { composeBrandBlock } from './brand-tool.js';
import { WORKFLOWS, workflowById } from './workflows/index.js';

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

// Content doctrine — prepended to every content draft (stable constant, so it stays in the cache
// prefix). Two baked-in tests: N-of-1 framing (only-you-could-make-it, rooted in lived experience) and
// the Content Filter (the four questions a post must answer, with exactly one CTA). The workflow also
// enforces the filter at the Copy→Distribution gate; this makes the drafting agent apply it up front.
export const CONTENT_DOCTRINE = [
  '[CONTENT DOCTRINE — apply before drafting]',
  'N-of-1 framing: make content only YOU could make — rooted in the operator\'s specific lived experience',
  '(the golden-cage story, the Dilo→Eidan lineage, Mathbuns-from-a-personal-need). "I built an agent platform',
  'while employed at a media company, two kids, AuDHD — here\'s what I learned" beats "5 tips for AI agents":',
  'nobody can copy your context. Frame every post, especially technical ones, as N-of-1.',
  '',
  'Content Filter — answer all four and include them as a short preamble in your output. If you cannot',
  'answer all four, STOP and ask before drafting:',
  '1. What single product, offer, or outcome does this post serve? ("building awareness" is not an answer.)',
  '2. What does the target reader/viewer want? (Their outcome, not the operator\'s.)',
  '3. How does this post move them one concrete step toward that outcome?',
  '4. What is the single CTA? (Exactly one of: follow, comment [word], DM, click link — never zero, never two.)',
].join('\n');

// The prompt a bounded stage-chat runs: content doctrine + shipped base prompt + brand block + card
// context, in that order (stable prefix first for prompt caching). Pure — unit-tested.
export function composeStagePrompt(stage: StageDef, brandBlock: string, cardContext: string): string {
  if (stage.action.type !== 'chat') return '';
  const parts: string[] = [CONTENT_DOCTRINE, stage.action.basePrompt];
  if (stage.action.skills?.length) parts.push(`\nLoad these skills first: ${stage.action.skills.join(', ')}.`);
  if (brandBlock.trim()) parts.push(`\n${brandBlock.trim()}`);
  if (cardContext.trim()) parts.push(`\n[CAMPAIGN CARD]\n${cardContext.trim()}`);
  parts.push(`\nWork iteratively; when the operator approves, this step's result is frozen onto the card slot "${stage.action.writes}".`);
  return parts.join('\n');
}

function summarize(w: WorkflowDef): Record<string, unknown> {
  return {
    id: w.id,
    label: w.label,
    appliesTo: w.appliesTo,
    stages: w.stages.map((s) => ({ id: s.id, label: s.label, gate: s.gate, kind: s.action.type })),
  };
}

export function buildWorkflowTool(db: ContentDb): Tool {
  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'stage_prompt'], description: 'list | get | stage_prompt' },
      workflow: { type: 'string', description: 'get / stage_prompt: workflow id (e.g. "linkedin-carousel").' },
      stage: { type: 'string', description: 'stage_prompt: stage id (e.g. "concept").' },
      scope: { type: 'string', description: 'stage_prompt: brand scope ("default" or a venture id/slug).' },
      card: { type: 'string', description: "stage_prompt: the card's current context (brief + prior slots) as text." },
    },
    required: ['action'],
    additionalProperties: false,
  };
  return {
    name: 'content_workflow',
    description:
      'The shipped content workflows (staged, board-based campaigns). Actions: { action: "list" } → all ' +
      'workflows; { action: "get", workflow } → one workflow\'s stages; { action: "stage_prompt", workflow, ' +
      'stage, scope?, card? } → the grounded prompt a bounded stage-chat should run (base prompt + brand kit ' +
      'for the scope + the card context). Use stage_prompt when opening a step\'s mini-chat from a card.',
    inputSchema,
    executor: {
      async *execute(input) {
        if (!tryCurrentPrincipal()) return yield { type: 'error', message: 'no user context' };
        const a = (input ?? {}) as Record<string, unknown>;
        const action = str(a['action']).trim();

        if (action === 'list') {
          return yield { type: 'result', value: { workflows: WORKFLOWS.map(summarize) } };
        }

        const wf = workflowById(str(a['workflow']).trim());
        if (!wf) return yield { type: 'error', message: `unknown workflow "${str(a['workflow'])}" — try content_workflow list` };

        if (action === 'get') {
          return yield { type: 'result', value: { workflow: summarize(wf) } };
        }
        if (action === 'stage_prompt') {
          const stage = wf.stages.find((s) => s.id === str(a['stage']).trim());
          if (!stage) return yield { type: 'error', message: `unknown stage "${str(a['stage'])}" in ${wf.id}` };
          if (stage.action.type !== 'chat') {
            return yield { type: 'result', value: { workflow: wf.id, stage: stage.id, deterministic: true, tool: stage.action.tool } };
          }
          const scope = str(a['scope']).trim() || 'default';
          const kit = await db.getBrand(scope);
          const prompt = composeStagePrompt(stage, composeBrandBlock(kit), str(a['card']));
          return yield { type: 'result', value: { workflow: wf.id, stage: stage.id, gate: stage.gate, writes: stage.action.writes, prompt } };
        }
        yield { type: 'error', message: `unknown action "${action}" — use list | get | stage_prompt` };
      },
    },
  };
}
