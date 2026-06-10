// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool } from '@matatbread/matbot-plugin-api';
import type { EidanMemory } from './eidan-memory.js';

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
