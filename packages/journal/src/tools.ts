// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent tools over the journal substrate. `journal_capture` is the deterministic write path the
// capturing agent calls (one call per distinct item); it persists a structured entry and, for a
// bug/task with a routable repo, opens a sage code job. `journal_query`/`journal_list` are the read
// paths the planning agents (and the operator) use; `journal_direction` gets/sets the editable
// direction prompt that governs how notes are categorised.
import type { JSONSchema, Tool } from '@matatbread/matbot-plugin-api';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';

import type { JournalDb } from './db.js';
import { captureAndRoute } from './routing.js';
import { ENTRY_TYPES, normalizeEntryType, type JournalEntry } from './types.js';

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
function noUser(): { type: 'error'; message: string } {
  return { type: 'error', message: 'no user context — the journal is owner-scoped' };
}
function digest(e: JournalEntry): Record<string, unknown> {
  return {
    id: e.id,
    project: e.project,
    entry_type: e.entry_type,
    summary: e.summary,
    target_repo: e.target_repo,
    job_id: e.job_id,
    created_at: e.created_at instanceof Date ? e.created_at.toISOString() : e.created_at,
  };
}

export function buildJournalTools(db: JournalDb): Tool[] {
  const obj = (properties: Record<string, unknown>, required: string[]): JSONSchema =>
    ({ type: 'object', properties, required, additionalProperties: false } as unknown as JSONSchema);

  return [
    {
      name: 'journal_capture',
      description:
        'Record ONE journal item from a note the operator dropped (text or transcribed voice). Call ' +
        'it once per distinct item. Categorise per the journal direction (read it with ' +
        'journal_direction): entry_type is one of ' + ENTRY_TYPES.join(' | ') + '. For a bug or task, ' +
        'set target_repo ("owner/name") to auto-delegate it to the sage code worker — omit if unsure ' +
        '(it is still logged). Returns the stored entry and, if delegated, the queued job id. This ' +
        'actually persists + routes the item — do not claim you journalled something without calling it.',
      inputSchema: obj(
        {
          project: { type: 'string', description: 'What the item concerns, e.g. "eidan", "mathgame", "adaptive-developer". Free text.' },
          entry_type: { type: 'string', enum: [...ENTRY_TYPES], description: 'devlog (did/shipped) | bug | task | idea | content_seed.' },
          summary: { type: 'string', description: 'One tight line capturing the item.', minLength: 1 },
          body: { type: 'string', description: 'Optional fuller detail / context.' },
          target_repo: { type: 'string', description: 'Bug/task only: "owner/name" to delegate to sage. Omit if unknown.' },
          source: { type: 'string', description: 'Optional origin hint, e.g. "telegram" or "chat".' },
        },
        ['summary'],
      ),
      executor: {
        async *execute(input) {
          const principal = tryCurrentPrincipal();
          if (!principal) return yield noUser();
          const a = (input ?? {}) as Record<string, unknown>;
          const summary = str(a['summary']).trim();
          if (!summary) return yield { type: 'error', message: 'summary is required' };
          const res = await captureAndRoute(db, principal.id, {
            project: str(a['project']).trim() || null,
            entry_type: normalizeEntryType(a['entry_type']),
            summary,
            body: str(a['body']).trim() || null,
            source: str(a['source']).trim() || null,
            target_repo: str(a['target_repo']).trim() || null,
          });
          if (!res) return yield { type: 'error', message: 'could not record the entry' };
          yield {
            type: 'result',
            value: {
              entry: digest(res.entry),
              routed: res.routed,
              ...(res.job_id ? { job_id: res.job_id } : {}),
            },
          };
        },
      },
    },
    {
      name: 'journal_query',
      description:
        'Read recent journal entries, filtered — the read API a planning agent uses to draft content. ' +
        'Filter by project, entry_type, and since (ISO timestamp, e.g. "2026-07-01"). Returns entries ' +
        'newest-first.',
      inputSchema: obj(
        {
          project: { type: 'string' },
          entry_type: { type: 'string', enum: [...ENTRY_TYPES] },
          since: { type: 'string', description: 'ISO timestamp lower bound, e.g. "2026-07-01".' },
          limit: { type: 'number', description: 'Max entries (default 50, cap 200).' },
        },
        [],
      ),
      executor: {
        async *execute(input) {
          if (!tryCurrentPrincipal()) return yield noUser();
          const a = (input ?? {}) as Record<string, unknown>;
          const entries = await db.queryEntries({
            project: str(a['project']).trim() || null,
            entry_type: a['entry_type'] ? normalizeEntryType(a['entry_type']) : null,
            since: str(a['since']).trim() || null,
            ...(typeof a['limit'] === 'number' ? { limit: a['limit'] } : {}),
          });
          yield { type: 'result', value: { count: entries.length, entries: entries.map(digest) } };
        },
      },
    },
    {
      name: 'journal_list',
      description: 'Quick list of the operator\'s most recent journal entries (default 20). For a scan, not analysis.',
      inputSchema: obj({ limit: { type: 'number' } }, []),
      executor: {
        async *execute(input) {
          if (!tryCurrentPrincipal()) return yield noUser();
          const a = (input ?? {}) as Record<string, unknown>;
          const limit = typeof a['limit'] === 'number' ? a['limit'] : 20;
          const entries = await db.queryEntries({ limit });
          yield { type: 'result', value: { count: entries.length, entries: entries.map(digest) } };
        },
      },
    },
    {
      name: 'journal_direction',
      description:
        'Get or set the journal direction prompt — the standing instruction for how notes are ' +
        'categorised and routed. Call with no argument to read it; pass `prompt` to replace it.',
      inputSchema: obj({ prompt: { type: 'string', description: 'New direction prompt. Omit to just read the current one.' } }, []),
      executor: {
        async *execute(input) {
          if (!tryCurrentPrincipal()) return yield noUser();
          const a = (input ?? {}) as Record<string, unknown>;
          const next = str(a['prompt']);
          if (next.trim()) {
            const saved = await db.setDirection(next);
            if (!saved) return yield { type: 'error', message: 'could not save the direction prompt' };
            return yield { type: 'result', value: { updated: true, direction_prompt: saved.direction_prompt } };
          }
          const current = await db.getDirection();
          yield { type: 'result', value: { direction_prompt: current } };
        },
      },
    },
  ];
}
