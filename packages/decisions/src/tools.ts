// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Store, Tool, JSONSchema, Filter, StoreQuery } from '@matatbread/matbot-plugin-api';
import type { DecisionRecord, DecisionStatus, JobCursorRecord } from './types.js';

const STATUSES: DecisionStatus[] = ['proposed', 'accepted', 'superseded', 'rejected'];

function s(v: unknown): string { return typeof v === 'string' ? v : v == null ? '' : String(v); }
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => s(x).trim()).filter((x) => x.length > 0) : [];
}
function nowIso(): string { return new Date().toISOString(); }
function isStatus(v: string): v is DecisionStatus { return (STATUSES as string[]).includes(v); }

// ── decision_record ─────────────────────────────────────────────────────────────
function recordTool(store: Store<DecisionRecord>): Tool {
  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      title:      { type: 'string', description: 'Short imperative headline of the decision.', minLength: 1 },
      decision:   { type: 'string', description: 'What was decided, stated plainly.', minLength: 1 },
      rationale:  { type: 'string', description: 'Why — the reasoning, trade-offs, and alternatives rejected.' },
      venture:    { type: 'string', description: 'Venture id/slug this decision is about (e.g. "acme-co"). ALWAYS set it for business/venture decisions (targeting, positioning, pricing, ICP) so the decision resurfaces whenever you work on that venture.' },
      tags:       { type: 'array', items: { type: 'string' }, description: 'Lowercase topic tags for retrieval (e.g. "deploy", "licensing").' },
      links:      { type: 'array', items: { type: 'string' }, description: 'Related [[knowledge-slug]] refs or URLs.' },
      status:     { type: 'string', enum: STATUSES, description: 'Lifecycle: proposed / accepted / superseded / rejected. Defaults to accepted.' },
      id:         { type: 'string', description: 'Omit to record a NEW decision; pass an existing id to update it.' },
      supersedes: { type: 'string', description: 'Id of a prior decision this one replaces (the old one is auto-marked superseded).' },
    },
    required: ['title', 'decision'],
    additionalProperties: false,
  };
  return {
    name: 'decision_record',
    description:
      'Record a decision in the searchable decision log so it is never re-litigated or forgotten. Use ' +
      'whenever you or the operator settle a non-obvious choice: capture WHAT was decided and WHY. ' +
      'Returns the stored record (with its id). Pass `id` to update an existing decision; pass ' +
      '`supersedes` to replace a prior one (it is marked superseded automatically).',
    inputSchema,
    executor: {
      async *execute(input) {
        const a = (input ?? {}) as Record<string, unknown>;
        const title = s(a['title']).trim();
        const decision = s(a['decision']).trim();
        if (!title || !decision) { yield { type: 'error', message: 'title and decision are required.' }; return; }

        const id = s(a['id']).trim() || crypto.randomUUID();
        const existing = await store.get(id);
        const statusIn = s(a['status']).trim();
        const status: DecisionStatus = isStatus(statusIn) ? statusIn : (existing?.status ?? 'accepted');
        const supersedes = s(a['supersedes']).trim() || existing?.supersedes || null;

        const rec: DecisionRecord = {
          id,
          version:    crypto.randomUUID(),
          title,
          decision,
          rationale:  a['rationale'] !== undefined ? s(a['rationale']).trim() : (existing?.rationale ?? ''),
          venture:    a['venture']   !== undefined ? (s(a['venture']).trim() || null) : (existing?.venture ?? null),
          tags:       a['tags']      !== undefined ? strArr(a['tags'])         : (existing?.tags ?? []),
          links:      a['links']     !== undefined ? strArr(a['links'])        : (existing?.links ?? []),
          status,
          supersedes,
          createdAt:  existing?.createdAt ?? nowIso(),
          updatedAt:  nowIso(),
        };
        await store.set(id, rec);

        // Mark the superseded decision, so a search surfaces the live one as current.
        if (supersedes && supersedes !== id) {
          const prior = await store.get(supersedes);
          if (prior && prior.status !== 'superseded') {
            await store.set(supersedes, { ...prior, version: crypto.randomUUID(), status: 'superseded', updatedAt: nowIso() });
          }
        }
        yield { type: 'result', value: rec };
      },
    },
  };
}

// ── decision_search ─────────────────────────────────────────────────────────────
function searchTool(store: Store<DecisionRecord>): Tool {
  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      text:   { type: 'string', description: 'Substring matched (case-sensitive) against title, decision, and rationale.' },
      venture:{ type: 'string', description: 'Return decisions about this venture (id/slug). Use this FIRST when working on a venture — retrieve its prior decisions before deriving anything new.' },
      tags:   { type: 'array', items: { type: 'string' }, description: 'Return decisions carrying ANY of these tags.' },
      status: { type: 'string', enum: STATUSES, description: 'Restrict to one lifecycle status.' },
      limit:  { type: 'number', description: 'Max results (default 20, newest first; capped at 100).' },
    },
    additionalProperties: false,
  };
  return {
    name: 'decision_search',
    description:
      'Search the decision log BEFORE making a call that may already have been decided. Filter by free ' +
      'text (title/decision/rationale), tags, and/or status. Returns matching decisions, newest first.',
    inputSchema,
    executor: {
      async *execute(input) {
        const a = (input ?? {}) as Record<string, unknown>;
        const clauses: Filter[] = [];

        const text = s(a['text']).trim();
        if (text) {
          clauses.push({ op: 'or', clauses: [
            { op: 'stringContains', field: 'title',     value: text },
            { op: 'stringContains', field: 'decision',  value: text },
            { op: 'stringContains', field: 'rationale', value: text },
          ] });
        }
        const venture = s(a['venture']).trim();
        if (venture) clauses.push({ op: 'eq', field: 'venture', value: venture });
        const tags = strArr(a['tags']);
        if (tags.length) {
          clauses.push({ op: 'or', clauses: tags.map((t): Filter => ({ op: 'arrayContains', field: 'tags', value: t })) });
        }
        const status = s(a['status']).trim();
        if (isStatus(status)) clauses.push({ op: 'eq', field: 'status', value: status });

        let where: Filter | undefined;
        if (clauses.length === 1) where = clauses[0];
        else if (clauses.length > 1) where = { op: 'and', clauses };

        const limRaw = Number(a['limit']);
        const limit = Number.isFinite(limRaw) && limRaw > 0 ? Math.min(Math.floor(limRaw), 100) : 20;

        const query: StoreQuery = {
          ...(where !== undefined ? { where } : {}),
          sort: [{ field: 'createdAt', dir: 'desc' }],
          limit,
        };
        const res = await store.query(query);
        yield { type: 'result', value: { items: res.items, total: res.total ?? res.items.length } };
      },
    },
  };
}

// ── job_cursor ────────────────────────────────────────────────────────────────────
function cursorTool(store: Store<JobCursorRecord>): Tool {
  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'set', 'list'], description: 'get one cursor, set/update one, or list all.' },
      job:    { type: 'string', description: 'The recurring job/agent name (the cursor key). Required for get and set.' },
      state:  { type: 'object', description: 'Arbitrary progress state to persist (set only) — e.g. {last_seen_id, offset, page}.' },
      note:   { type: 'string', description: 'Optional human-readable note about where the job is (set only).' },
    },
    required: ['action'],
    additionalProperties: false,
  };
  return {
    name: 'job_cursor',
    description:
      'Durable per-job cursor: remember where a recurring job or agent left off so the next run resumes ' +
      'instead of repeating work. `get` at the start of a run, `set` to save progress, `list` to see all.',
    inputSchema,
    executor: {
      async *execute(input) {
        const a = (input ?? {}) as Record<string, unknown>;
        const action = s(a['action']).trim();
        const job = s(a['job']).trim();

        if (action === 'get') {
          if (!job) { yield { type: 'error', message: 'get requires "job".' }; return; }
          yield { type: 'result', value: await store.get(job) };
          return;
        }
        if (action === 'set') {
          if (!job) { yield { type: 'error', message: 'set requires "job".' }; return; }
          const existing = await store.get(job);
          const stateIn = a['state'];
          const rec: JobCursorRecord = {
            id:        job,
            version:   crypto.randomUUID(),
            job,
            state:     stateIn !== null && typeof stateIn === 'object' && !Array.isArray(stateIn)
              ? stateIn as Record<string, unknown>
              : (existing?.state ?? {}),
            note:      a['note'] !== undefined ? s(a['note']).trim() : (existing?.note ?? ''),
            updatedAt: nowIso(),
          };
          await store.set(job, rec);
          yield { type: 'result', value: rec };
          return;
        }
        if (action === 'list') {
          const res = await store.query({ sort: [{ field: 'updatedAt', dir: 'desc' }], limit: 100 });
          yield { type: 'result', value: { items: res.items } };
          return;
        }
        yield { type: 'error', message: `Unknown action "${action}". Expected get, set, or list.` };
      },
    },
  };
}

export function buildDecisionTools(decisions: Store<DecisionRecord>, cursors: Store<JobCursorRecord>): Tool[] {
  return [recordTool(decisions), searchTool(decisions), cursorTool(cursors)];
}
