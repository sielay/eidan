// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent tools over the boards substrate — boards + rich cards (typed refs, status, activity log).
// Mirrors the streaming `executor` tool shape used across the eidan bundles.
import type { JSONSchema, Tool } from '@matatbread/matbot-plugin-api';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';

import type { BoardsDb } from './db.js';
import { CARD_STATUSES } from './db.js';

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
function noUser(): { type: 'error'; message: string } {
  return { type: 'error', message: 'no user context — boards are owner-scoped' };
}

export function buildBoardsTools(db: BoardsDb): Tool[] {
  const obj = (properties: Record<string, unknown>, required: string[]): JSONSchema =>
    ({ type: 'object', properties, required, additionalProperties: false } as unknown as JSONSchema);

  return [
    {
      name: 'board_list',
      description: 'List the operator\'s boards. Optionally filter by scope — scope_kind/scope_id bind a board to a context (e.g. "venture"/<id>); omit both for standalone/personal boards.',
      inputSchema: obj({ scope_kind: { type: 'string' }, scope_id: { type: 'string' } }, []),
      executor: {
        async *execute(input) {
          if (!tryCurrentPrincipal()) return yield noUser();
          const a = (input ?? {}) as Record<string, unknown>;
          const sk = str(a['scope_kind']).trim() || null;
          const si = str(a['scope_id']).trim() || null;
          const boards = await db.listBoards(sk, si);
          yield { type: 'result', value: { boards } };
        },
      },
    },
    {
      name: 'board_create',
      description: 'Create a board. Bind it to a context with scope_kind/scope_id (e.g. "venture"/<venture id>), or omit for a standalone board.',
      inputSchema: obj({ name: { type: 'string' }, scope_kind: { type: 'string' }, scope_id: { type: 'string' } }, ['name']),
      executor: {
        async *execute(input) {
          if (!tryCurrentPrincipal()) return yield noUser();
          const a = (input ?? {}) as Record<string, unknown>;
          const name = str(a['name']).trim();
          if (!name) return yield { type: 'error', message: 'name is required' };
          const board = await db.createBoard(name, str(a['scope_kind']).trim() || null, str(a['scope_id']).trim() || null);
          if (!board) return yield { type: 'error', message: 'could not create board' };
          yield { type: 'result', value: board };
        },
      },
    },
    {
      name: 'board_rename',
      description: 'Rename a board.',
      inputSchema: obj({ board_id: { type: 'string' }, name: { type: 'string' } }, ['board_id', 'name']),
      executor: {
        async *execute(input) {
          if (!tryCurrentPrincipal()) return yield noUser();
          const a = (input ?? {}) as Record<string, unknown>;
          const board = await db.renameBoard(str(a['board_id']).trim(), str(a['name']).trim());
          if (!board) return yield { type: 'error', message: 'no such board' };
          yield { type: 'result', value: board };
        },
      },
    },
    {
      name: 'board_set_prompt',
      description: "Set (or clear) a board's prompt — standing context explaining what the board is for, " +
        'so agents working its cards know the goal. Markdown. Pass an empty prompt to clear it.',
      inputSchema: obj({ board_id: { type: 'string' }, prompt: { type: 'string' } }, ['board_id']),
      executor: {
        async *execute(input) {
          if (!tryCurrentPrincipal()) return yield noUser();
          const a = (input ?? {}) as Record<string, unknown>;
          const board = await db.setBoardPrompt(str(a['board_id']).trim(), str(a['prompt'] ?? '').trim() || null);
          if (!board) return yield { type: 'error', message: 'no such board' };
          yield { type: 'result', value: board };
        },
      },
    },
    {
      name: 'board_archive',
      description: 'Archive a board and its cards (soft-remove).',
      inputSchema: obj({ board_id: { type: 'string' } }, ['board_id']),
      executor: {
        async *execute(input) {
          if (!tryCurrentPrincipal()) return yield noUser();
          const a = (input ?? {}) as Record<string, unknown>;
          const ok = await db.archiveBoard(str(a['board_id']).trim());
          if (!ok) return yield { type: 'error', message: 'no such board' };
          yield { type: 'result', value: { ok: true } };
        },
      },
    },
    {
      name: 'card_list',
      description: 'List the live cards on a board (excludes archived). Cards are sorted by due_date ascending (earliest first, then nulls last).',
      inputSchema: obj({ board_id: { type: 'string' } }, ['board_id']),
      executor: {
        async *execute(input) {
          if (!tryCurrentPrincipal()) return yield noUser();
          const a = (input ?? {}) as Record<string, unknown>;
          const cards = await db.listCards(str(a['board_id']).trim());
          yield { type: 'result', value: { cards } };
        },
      },
    },
    {
      name: 'card_add',
      description: 'Add a card to a board.',
      inputSchema: obj({ board_id: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, due_date: { type: 'string' } }, ['board_id', 'title']),
      executor: {
        async *execute(input) {
          if (!tryCurrentPrincipal()) return yield noUser();
          const a = (input ?? {}) as Record<string, unknown>;
          const title = str(a['title']).trim();
          if (!title) return yield { type: 'error', message: 'title is required' };
          const dueDate = str(a['due_date']).trim() || null;
          const card = await db.createCard(str(a['board_id']).trim(), title, str(a['body']).trim() || null, dueDate);
          if (!card) return yield { type: 'error', message: 'no such board' };
          yield { type: 'result', value: card };
        },
      },
    },
    {
      name: 'card_update',
      description: "Update a card — title, body, status (open / doing / done / 'archived' to remove), or due_date (ISO 8601 date). Only the fields you pass change.",
      inputSchema: obj({ card_id: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, status: { type: 'string', enum: CARD_STATUSES }, due_date: { type: 'string' } }, ['card_id']),
      executor: {
        async *execute(input) {
          if (!tryCurrentPrincipal()) return yield noUser();
          const a = (input ?? {}) as Record<string, unknown>;
          const patch: { title?: string; body?: string; status?: string; due_date?: string | null } = {};
          if (a['title'] !== undefined) patch.title = str(a['title']).trim();
          if (a['body'] !== undefined) patch.body = str(a['body']).trim();
          if (a['status'] !== undefined) {
            const s = str(a['status']);
            if (!CARD_STATUSES.includes(s)) return yield { type: 'error', message: `status must be one of ${CARD_STATUSES.join(', ')}` };
            patch.status = s;
          }
          if (a['due_date'] !== undefined) patch.due_date = str(a['due_date']).trim() || null;
          const card = await db.updateCard(str(a['card_id']).trim(), patch);
          if (!card) return yield { type: 'error', message: 'no such card (or nothing to update)' };
          yield { type: 'result', value: card };
        },
      },
    },
    {
      name: 'card_link',
      description: 'Attach a typed reference to a card — link it to an asset, venture, job, agent (or url/domain/etc). ref_kind is the type, ref_id the target id, ref_label a human label.',
      inputSchema: obj({ card_id: { type: 'string' }, ref_kind: { type: 'string' }, ref_id: { type: 'string' }, ref_label: { type: 'string' } }, ['card_id', 'ref_kind']),
      executor: {
        async *execute(input) {
          if (!tryCurrentPrincipal()) return yield noUser();
          const a = (input ?? {}) as Record<string, unknown>;
          const kind = str(a['ref_kind']).trim();
          if (!kind) return yield { type: 'error', message: 'ref_kind is required' };
          const ref = await db.addRef(str(a['card_id']).trim(), kind, str(a['ref_id']).trim() || null, str(a['ref_label']).trim() || null);
          if (!ref) return yield { type: 'error', message: 'no such card' };
          yield { type: 'result', value: ref };
        },
      },
    },
    {
      name: 'card_unlink',
      description: 'Remove a reference from a card (by ref id).',
      inputSchema: obj({ ref_id: { type: 'string' } }, ['ref_id']),
      executor: {
        async *execute(input) {
          if (!tryCurrentPrincipal()) return yield noUser();
          const a = (input ?? {}) as Record<string, unknown>;
          const ok = await db.removeRef(str(a['ref_id']).trim());
          if (!ok) return yield { type: 'error', message: 'no such reference' };
          yield { type: 'result', value: { ok: true } };
        },
      },
    },
    {
      name: 'card_refs',
      description: 'List the references attached to a card.',
      inputSchema: obj({ card_id: { type: 'string' } }, ['card_id']),
      executor: {
        async *execute(input) {
          if (!tryCurrentPrincipal()) return yield noUser();
          const a = (input ?? {}) as Record<string, unknown>;
          const refs = await db.listRefs(str(a['card_id']).trim());
          yield { type: 'result', value: { refs } };
        },
      },
    },
    {
      name: 'card_comment',
      description: 'Add a comment to a card\'s activity log.',
      inputSchema: obj({ card_id: { type: 'string' }, body: { type: 'string' } }, ['card_id', 'body']),
      executor: {
        async *execute(input, ctx) {
          if (!tryCurrentPrincipal()) return yield noUser();
          const a = (input ?? {}) as Record<string, unknown>;
          const body = str(a['body']).trim();
          if (!body) return yield { type: 'error', message: 'body is required' };
          // Attribute to the firing agent (Eidan / a custom agent / Sage) so the comment shows the
          // right name + avatar; fall back to Eidan for the default assistant.
          const convId = ctx?.session?.id;
          const agent = convId ? await db.resolveAgent(convId) : null;
          const author = agent ? { kind: 'agent', id: agent.id, label: agent.name } : { kind: 'agent', id: 'eidan', label: 'Eidan' };
          const ev = await db.addEvent(str(a['card_id']).trim(), 'comment', body, author);
          if (!ev) return yield { type: 'error', message: 'no such card' };
          yield { type: 'result', value: ev };
        },
      },
    },
    {
      name: 'card_activity',
      description: 'List a card\'s activity log — comments, status changes, links — oldest first.',
      inputSchema: obj({ card_id: { type: 'string' } }, ['card_id']),
      executor: {
        async *execute(input) {
          if (!tryCurrentPrincipal()) return yield noUser();
          const a = (input ?? {}) as Record<string, unknown>;
          const events = await db.listEvents(str(a['card_id']).trim());
          yield { type: 'result', value: { events } };
        },
      },
    },
  ];
}
