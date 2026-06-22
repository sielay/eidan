// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool, JSONSchema } from '@matatbread/matbot-plugin-api';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import type { Db } from './db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function s(v: unknown): string { return typeof v === 'string' ? v : v == null ? '' : String(v); }

// `delegate` — the LLM-facing primitive for putting a job on the eidan.jobs work-queue. Without it
// the assistant can only *talk* about delegating; the queue + the sage `code` worker already exist,
// this is the missing enqueue surface. A `code` job is claimed by a node serving that kind (the Pi),
// which clones the repo, drives the coder, and opens a PR for review — it never merges.
function delegateTool(db: Db): Tool {
  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      goal:  { type: 'string', description: 'The FULL, self-contained task brief. The worker works from this (not a GitHub issue body), so include everything: what to build/fix, acceptance criteria, constraints, and `Closes #<n>` if an issue exists.', minLength: 1 },
      repo:  { type: 'string', description: 'Target repository as "owner/name" (e.g. "sielay/eidan"). A write PAT for it must be configured (EIDAN_GH_PATS).', minLength: 1 },
      title: { type: 'string', description: 'Short title for the task / PR.' },
      stack: { type: 'string', description: 'Coding stack/handler the worker uses. Default "sage".' },
      kind:  { type: 'string', description: 'Work-queue kind. Default "code" (the sage coding loop). Only change for a different registered handler.' },
      node:  { type: 'string', description: 'Pin the job to a specific node by EIDAN_NODE_ID (e.g. "kesha"). Default: any capable node may claim it.' },
      model: { type: 'string', description: "Override the model the worker runs under. Default: the handler's default." },
      provider: { type: 'string', description: "Override the provider the worker runs under. Default: the handler's default." },
    },
    required: ['goal', 'repo'],
    additionalProperties: false,
  };
  return {
    name: 'delegate',
    description:
      'Delegate a self-contained CODING task to the background code worker (sage): it clones the repo, ' +
      'writes the change, and opens a PR for human review — it never auto-merges. Use when the operator ' +
      'asks to build or fix something in a repo. Returns the queued job id; track it in the Agents/Jobs ' +
      'view. This actually enqueues the work — do not claim a task is delegated without calling it.',
    inputSchema,
    executor: {
      async *execute(input, ctx) {
        const a = (input ?? {}) as Record<string, unknown>;
        const goal = s(a['goal']).trim();
        const repo = s(a['repo']).trim();
        if (!goal) { yield { type: 'error', message: 'goal is required (the full task brief).' }; return; }
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { yield { type: 'error', message: `repo must be "owner/name" — got "${repo}".` }; return; }
        const title = s(a['title']).trim();
        const stack = s(a['stack']).trim() || 'sage';
        const kind = s(a['kind']).trim() || 'code';
        const node = s(a['node']).trim() || null;       // enforced at claim time
        const model = s(a['model']).trim() || null;
        const provider = s(a['provider']).trim() || null;

        // user_id (ownership; escalations + the run inherit it). The ambient principal is a uuid for
        // web users; for non-uuid principals (e.g. telegram-…) leave it null and keep the id in payload.
        const pid = tryCurrentPrincipal()?.id ?? '';
        const userId = UUID_RE.test(pid) ? pid : null;
        const payload = { repo, stack, ...(title ? { title } : {}), ...(userId ? {} : { requested_by: pid }) };

        // Attribute the job to the firing agent if this turn runs under one — the agent runtime stamps
        // the conversation with agent_id, so resolve its name. Best-effort; a human/chat delegate is null.
        let agent: string | null = null;
        const convId = ctx?.session?.id;
        if (convId && UUID_RE.test(convId)) {
          try {
            const ar = await db.query(
              `select a.name from eidan.conversations c join eidan.agents a on a.id = c.agent_id where c.id = $1`,
              [convId],
            );
            agent = (ar.rows[0] as { name?: string } | undefined)?.name ?? null;
          } catch { /* attribution is a nicety, never block the enqueue */ }
        }

        const r = await db.query(
          `insert into eidan.jobs (kind, goal, payload, user_id, status, surface, target_node, model, provider, agent)
           values ($1, $2, $3::jsonb, $4::uuid, 'queued', 'delegate', $5, $6, $7, $8) returning id`,
          [kind, goal, JSON.stringify(payload), userId, node, model, provider, agent],
        );
        const jobId = (r.rows[0] as { id: string } | undefined)?.id ?? null;
        if (!jobId) { yield { type: 'error', message: 'failed to enqueue the job.' }; return; }
        yield { type: 'result', value: { job_id: jobId, kind, repo, stack, status: 'queued', ...(node ? { node } : {}), ...(agent ? { agent } : {}) } };
      },
    },
  };
}

export function buildJobTools(db: Db): Tool[] {
  return [delegateTool(db)];
}
