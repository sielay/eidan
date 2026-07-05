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

// The prompt a bounded stage-chat runs: shipped base prompt + brand block + card context, in that
// order (stable prefix first for prompt caching). Pure — unit-tested.
export function composeStagePrompt(stage: StageDef, brandBlock: string, cardContext: string): string {
  if (stage.action.type !== 'chat') return '';
  const parts: string[] = [stage.action.basePrompt];
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
