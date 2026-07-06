// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool } from '@matatbread/matbot-plugin-api';
import { currentPrincipal } from '@matatbread/matbot-plugin-api';
import type { EidanMemory } from './eidan-memory.js';
import type { Db } from './db.js';

// The agent-facing memory loop ported onto matbot's Tool API (eidan's capture/learn).
// Each tool closes over the EidanMemory instance built in setup(); the ambient principal
// (set per turn by the runner's runAs) flows into the relational writes/reads underneath.

export function rememberTool(mem: EidanMemory): Tool {
  return {
    name: 'remember',
    description: 'Save a durable, skill-tagged knowledge entry to long-term memory so it can be recalled in future conversations.',
    inputSchema: {
      type: 'object',
      required: ['skill', 'title', 'body'],
      additionalProperties: false,
      properties: {
        skill: { type: 'string', description: 'Free-text domain tag, e.g. "gardening", "python", "home-network".' },
        title: { type: 'string', description: 'Short unique title for this entry within the skill.' },
        body:  { type: 'string', description: 'The knowledge to store, as markdown.' },
      },
    },
    executor: {
      async *execute(input) {
        const { skill, title, body } = input as { skill: string; title: string; body: string };
        const id = await mem.remember({ skill, title, body });
        yield { type: 'result', value: { id, saved: true } };
      },
    },
  };
}

export function recallTool(mem: EidanMemory): Tool {
  return {
    name: 'recall',
    description: 'Search long-term knowledge by query and return the most relevant entries (ranked).',
    inputSchema: {
      type: 'object',
      required: ['query'],
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'What to look for.' },
        limit: { type: 'number', description: 'Max entries to return (default 10).' },
      },
    },
    executor: {
      async *execute(input) {
        const { query, limit } = input as { query: string; limit?: number };
        const hits = await mem.searchKnowledge(query, limit ?? 10);
        yield { type: 'result', value: { hits } };
      },
    },
  };
}

export function knowledgeCaptureWorkflowTool(mem: EidanMemory): Tool {
  return {
    name: 'knowledge_capture_workflow',
    description:
      'Multi-step workflow to capture learning transcripts into the knowledge catalogue. ' +
      'Accepts transcript text or summary, extracts key concepts (auto), prompts for tags (ventures/goals/issues/personal/topics), ' +
      'and stores the entry. Use this to catalogue videos, articles, emails, or chat summaries against your ventures and goals.',
    inputSchema: {
      type: 'object',
      required: ['title', 'content', 'source'],
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Short title for this knowledge (e.g., "Delegation best practices from Loom video").' },
        content: { type: 'string', description: 'Full transcript, summary, or key points from the source.' },
        source: {
          type: 'string',
          enum: ['youtube', 'article', 'email', 'chat', 'transcript', 'manual', 'imported', 'other'],
          description: 'Where this learning came from.',
        },
        source_url: { type: 'string', description: 'Optional link to the source.' },
        key_concepts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: extracted bullet points. If omitted, AI will suggest them.',
        },
        tags: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ventures: { type: 'array', items: { type: 'string' }, description: 'Venture ids/slugs (e.g., ["eidan", "mathbuns"]).' },
            goals: { type: 'array', items: { type: 'string' }, description: 'Goal names or ids.' },
            issues: { type: 'array', items: { type: 'string' }, description: 'Problem areas (e.g., ["delegation", "pricing"]).' },
            personal: { type: 'array', items: { type: 'string' }, description: 'Skills, health, family areas.' },
            topics: { type: 'array', items: { type: 'string' }, description: 'Free-form topic keywords.' },
          },
          description: 'Tags that link this knowledge to your ventures, goals, and life context.',
        },
      },
    },
    executor: {
      async *execute(input) {
        const {
          title,
          content,
          source,
          source_url,
          key_concepts,
          tags,
        } = input as {
          title: string;
          content: string;
          source: string;
          source_url?: string;
          key_concepts?: string[];
          tags?: Record<string, string[]>;
        };

        if (!title?.trim()) { yield { type: 'error', message: 'title is required' }; return; }
        if (!content?.trim()) { yield { type: 'error', message: 'content is required' }; return; }

        const id = await mem.catalogueCapture({
          title,
          content,
          source,
          source_url,
          key_concepts,
          tags: {
            ventures: tags?.ventures,
            goals: tags?.goals,
            issues: tags?.issues,
            personal: tags?.personal,
            topics: tags?.topics,
          },
        });

        yield {
          type: 'result',
          value: {
            id,
            captured: true,
            message: `Captured "${title}" to knowledge catalogue. Status: raw → review and tag further if needed.`,
          },
        };
      },
    },
  };
}

export function knowledgeRecallTool(mem: EidanMemory): Tool {
  return {
    name: 'knowledge_recall',
    description:
      'Proactively recall relevant knowledge from the catalogue by ventures, goals, issues, or free-text query. ' +
      'Returns top entries ranked by tag match and recency. Use this to surface prior learnings when the operator mentions a venture, goal, or problem.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ventures: { type: 'array', items: { type: 'string' }, description: 'Venture slugs to recall knowledge for.' },
        goals: { type: 'array', items: { type: 'string' }, description: 'Goals to recall knowledge for.' },
        issues: { type: 'array', items: { type: 'string' }, description: 'Issue tags to recall knowledge for.' },
        personal: { type: 'array', items: { type: 'string' }, description: 'Personal domain tags.' },
        topics: { type: 'array', items: { type: 'string' }, description: 'Topic keywords.' },
        query: { type: 'string', description: 'Optional: free-text search query (combined with tags).' },
        limit: { type: 'number', description: 'Max results (default 5, max 50).' },
      },
    },
    executor: {
      async *execute(input) {
        const opts = input as {
          ventures?: string[];
          goals?: string[];
          issues?: string[];
          personal?: string[];
          topics?: string[];
          query?: string;
          limit?: number;
        };

        const entries = await mem.catalogueRecall(opts);

        if (!entries.length) {
          yield { type: 'result', value: { entries: [], message: 'No matching knowledge found in catalogue.' } };
          return;
        }

        yield {
          type: 'result',
          value: {
            entries,
            count: entries.length,
            message: `Recalled ${entries.length} knowledge entry/entries from catalogue.`,
          },
        };
      },
    },
  };
}

export function knowledgeCatalogueListTool(mem: EidanMemory): Tool {
  return {
    name: 'knowledge_catalogue_list',
    description: 'List recent captured knowledge by status (raw, catalogued, or archived). Use to review and curate your catalogue.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['raw', 'catalogued', 'archived'], description: 'Filter by status (default: all statuses).' },
        limit: { type: 'number', description: 'Max entries (default 50, max 200).' },
      },
    },
    executor: {
      async *execute(input) {
        const opts = input as { status?: string; limit?: number };
        const entries = await mem.catalogueList(opts);

        yield {
          type: 'result',
          value: {
            entries,
            count: entries.length,
            message: `Listed ${entries.length} knowledge entries.`,
          },
        };
      },
    },
  };
}

// Conversation housekeeping, agent-facing (the tool half of the UI's "delete a conversation" — the
// user asked for both "by user or by agent if agent called that tool"). Principal-scoped via the same
// RLS transaction helper, so an agent can only ever see/delete its owner's conversations. Soft-delete
// only (deleted_at): the rows stay for audit, they just drop out of every list.
export function conversationListTool(db: Db): Tool {
  return {
    name: 'conversation_list',
    description: "List your recent conversations (id, title, last activity) so you can find one to delete. Newest first.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: 'Max conversations to return (default 30).' },
      },
    },
    executor: {
      async *execute(input) {
        const { limit } = input as { limit?: number };
        const n = Math.min(Math.max(Number(limit) || 30, 1), 100);
        const rows = await db.withPrincipalTx(async (q) => {
          const r = await q(
            `select id, title, updated_at from eidan.conversations
               where user_id = $1 and deleted_at is null
               order by updated_at desc nulls last limit $2`,
            [currentPrincipal().id, n],
          );
          return r.rows as Array<{ id: string; title: string | null; updated_at: string | null }>;
        });
        yield { type: 'result', value: { conversations: rows } };
      },
    },
  };
}

export function conversationArchiveTool(db: Db): Tool {
  return {
    name: 'conversation_archive',
    description: 'Delete (soft-archive) one of your conversations by id. The conversation drops out of every list; its messages are kept for audit. Irreversible from the chat UI, so confirm the id first (use conversation_list).',
    inputSchema: {
      type: 'object',
      required: ['id'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Conversation id to delete (from conversation_list).' },
      },
    },
    executor: {
      async *execute(input) {
        const { id } = input as { id: string };
        if (!id || typeof id !== 'string') { yield { type: 'result', value: { deleted: false, error: 'id is required' } }; return; }
        const ok = await db.withPrincipalTx(async (q) => {
          const r = await q(
            `update eidan.conversations set deleted_at = now(), updated_at = now()
               where id = $1 and user_id = $2 and deleted_at is null`,
            [id, currentPrincipal().id],
          );
          return (r.rowCount ?? 0) > 0;
        });
        yield { type: 'result', value: ok ? { deleted: true, id } : { deleted: false, error: 'no such conversation (already deleted, or not yours)' } };
      },
    },
  };
}
