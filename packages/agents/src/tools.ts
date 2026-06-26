// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool, JSONSchema } from '@matatbread/matbot-plugin-api';
import { AgentsStore, type AgentRow, type TriggerRow } from './store.js';
import { isValidSchedule } from './schedule.js';

const SCHEDULE_HELP =
  'When to run. Clock (owner timezone): "HH:MM" every day (e.g. "08:00"), or "<days> HH:MM" for ' +
  'weekdays (e.g. "mon,wed,fri 08:00"). Interval: "every 5 minutes", "every 2 hours", "hourly". ' +
  'Days are mon/tue/wed/thu/fri/sat/sun.';

const PROVIDER_HELP =
  'Which model provider this agent runs on (e.g. "claude", "openrouter", "ollama"). Omit to use the ' +
  'node default. Note: the provider must be registered on the node that runs the agent, or the turn fails.';

const TARGET_HELP =
  'Pin the agent to a specific node by its EIDAN_NODE_ID (e.g. "kesha"), needed when its provider only ' +
  'exists on one node (free local ollama lives on the Pi). Omit to let any capable node run it.';

function agentView(a: AgentRow): Record<string, unknown> {
  return { id: a.id, name: a.name, persona: a.persona, provider: a.provider, model: a.model, target_node: a.target_node, enabled: a.enabled };
}

function triggerView(t: TriggerRow): Record<string, unknown> {
  return { id: t.id, type: t.type, config: t.config, enabled: t.enabled };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

const CREATE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short label for the agent (e.g. "Vercel log analyst").', minLength: 1 },
    persona: { type: 'string', description: 'The agent\'s standing role / instruction — what it should do each time it runs (e.g. "Review my unread mail from Vercel and summarise any errors or anomalies").', minLength: 1 },
    provider: { type: 'string', description: PROVIDER_HELP, minLength: 1 },
    model: { type: 'string', description: 'Optional explicit model override; omit for the provider default.', minLength: 1 },
    target_node: { type: 'string', description: TARGET_HELP, minLength: 1 },
  },
  required: ['name', 'persona'],
  additionalProperties: false,
};

const LIST_SCHEMA: JSONSchema = { type: 'object', properties: {}, additionalProperties: false };

const UPDATE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'The agent to change.', minLength: 1 },
    name: { type: 'string', description: 'New label; omit to leave unchanged.', minLength: 1 },
    persona: { type: 'string', description: 'New role/instruction; omit to leave unchanged.', minLength: 1 },
    provider: { type: 'string', description: `New provider; omit to leave unchanged. ${PROVIDER_HELP}`, minLength: 1 },
    model: { type: 'string', description: 'New model override; omit to leave unchanged.', minLength: 1 },
    target_node: { type: 'string', description: `New target node; omit to leave unchanged. ${TARGET_HELP}`, minLength: 1 },
    enabled: { type: 'boolean', description: 'Pause (false) or resume (true) the agent; omit to leave unchanged.' },
  },
  required: ['id'],
  additionalProperties: false,
};

const DELETE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: { id: { type: 'string', description: 'The agent to delete.', minLength: 1 } },
  required: ['id'],
  additionalProperties: false,
};

const SCHEDULE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    agent_id: { type: 'string', description: 'The agent to attach a schedule trigger to.', minLength: 1 },
    schedule: { type: 'string', description: SCHEDULE_HELP, minLength: 1 },
  },
  required: ['agent_id', 'schedule'],
  additionalProperties: false,
};

const RESPONSE_TRIGGER_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    agent_id: { type: 'string', description: 'The agent to attach a response trigger to.', minLength: 1 },
  },
  required: ['agent_id'],
  additionalProperties: false,
};

const TRIGGER_DELETE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: { id: { type: 'string', description: 'The trigger to remove.', minLength: 1 } },
  required: ['id'],
  additionalProperties: false,
};

export function buildAgentTools(store: AgentsStore): Tool[] {
  return [
    {
      name: 'agent_create',
      description:
        'Create a user-defined agent — a configured persona with its own model provider. The agent does ' +
        'nothing until you attach a trigger (e.g. agent_schedule). Use when the operator wants a standing ' +
        'helper that runs on its own (a researcher, a log analyst, a daily thinker).',
      inputSchema: CREATE_SCHEMA,
      executor: {
        async *execute(input) {
          const args = (input ?? {}) as Record<string, unknown>;
          const name = str(args['name']).trim();
          const persona = str(args['persona']).trim();
          if (!name || !persona) return yield { type: 'error', message: 'name and persona are required' };
          const provider = args['provider'] !== undefined ? str(args['provider']).trim() : null;
          const model = args['model'] !== undefined ? str(args['model']).trim() : null;
          const targetNode = args['target_node'] !== undefined ? str(args['target_node']).trim() : null;
          const row = await store.createAgent({ name, persona, provider, model, target_node: targetNode });
          yield { type: 'result', value: agentView(row) };
        },
      },
    },
    {
      name: 'agent_list',
      description: "List the operator's agents with their triggers. Use to review what agents exist before creating or changing one.",
      inputSchema: LIST_SCHEMA,
      executor: {
        async *execute() {
          const agents = await store.listAgents();
          const out: Record<string, unknown>[] = [];
          for (const a of agents) {
            const triggers = await store.listTriggers(a.id);
            out.push({ ...agentView(a), triggers: triggers.map(triggerView) });
          }
          yield { type: 'result', value: { agents: out } };
        },
      },
    },
    {
      name: 'agent_update',
      description: 'Change an agent — rename it, edit its persona, switch its provider/model, or pause/resume it (enabled). Only the fields you pass change.',
      inputSchema: UPDATE_SCHEMA,
      executor: {
        async *execute(input) {
          const args = (input ?? {}) as Record<string, unknown>;
          const id = str(args['id']).trim();
          if (!id) return yield { type: 'error', message: 'id is required' };
          const patch: { name?: string; persona?: string; provider?: string | null; model?: string | null; target_node?: string | null; enabled?: boolean } = {};
          if (args['name'] !== undefined) { const v = str(args['name']).trim(); if (!v) return yield { type: 'error', message: 'name cannot be blank' }; patch.name = v; }
          if (args['persona'] !== undefined) { const v = str(args['persona']).trim(); if (!v) return yield { type: 'error', message: 'persona cannot be blank' }; patch.persona = v; }
          if (args['provider'] !== undefined) { patch.provider = str(args['provider']).trim() || null; }
          if (args['model'] !== undefined) { patch.model = str(args['model']).trim() || null; }
          if (args['target_node'] !== undefined) { patch.target_node = str(args['target_node']).trim() || null; }
          if (typeof args['enabled'] === 'boolean') patch.enabled = args['enabled'];
          const row = await store.updateAgent(id, patch);
          if (!row) return yield { type: 'error', message: 'no such agent' };
          yield { type: 'result', value: agentView(row) };
        },
      },
    },
    {
      name: 'agent_delete',
      description: 'Delete an agent (and its triggers) so it no longer runs.',
      inputSchema: DELETE_SCHEMA,
      executor: {
        async *execute(input) {
          const args = (input ?? {}) as Record<string, unknown>;
          const id = str(args['id']).trim();
          if (!id) return yield { type: 'error', message: 'id is required' };
          const ok = await store.removeAgent(id);
          if (!ok) return yield { type: 'error', message: 'no such agent' };
          yield { type: 'result', value: { deleted: true, id } };
        },
      },
    },
    {
      name: 'agent_schedule',
      description: 'Attach a recurring schedule trigger to an agent — it will run automatically on the given cadence. (Sensor and webhook triggers are coming; this is the schedule one.)',
      inputSchema: SCHEDULE_SCHEMA,
      executor: {
        async *execute(input) {
          const args = (input ?? {}) as Record<string, unknown>;
          const agentId = str(args['agent_id']).trim();
          const schedule = str(args['schedule']).trim();
          if (!agentId || !schedule) return yield { type: 'error', message: 'agent_id and schedule are required' };
          if (!isValidSchedule(schedule)) return yield { type: 'error', message: `invalid schedule "${schedule}". ${SCHEDULE_HELP}` };
          try {
            const t = await store.addTrigger(agentId, 'schedule', { schedule });
            yield { type: 'result', value: triggerView(t) };
          } catch (e) {
            yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
          }
        },
      },
    },
    {
      name: 'agent_response_trigger',
      description: 'Attach a response trigger to an agent — it will fire immediately when an escalation directed to it is answered by the operator, with the agent\'s persona modified by the escalation\'s trigger_prompt.',
      inputSchema: RESPONSE_TRIGGER_SCHEMA,
      executor: {
        async *execute(input) {
          const args = (input ?? {}) as Record<string, unknown>;
          const agentId = str(args['agent_id']).trim();
          if (!agentId) return yield { type: 'error', message: 'agent_id is required' };
          try {
            const t = await store.addTrigger(agentId, 'response', {});
            yield { type: 'result', value: triggerView(t) };
          } catch (e) {
            yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
          }
        },
      },
    },
    {
      name: 'agent_trigger_delete',
      description: 'Remove a trigger from an agent (the agent stays; it just stops firing on that trigger).',
      inputSchema: TRIGGER_DELETE_SCHEMA,
      executor: {
        async *execute(input) {
          const args = (input ?? {}) as Record<string, unknown>;
          const id = str(args['id']).trim();
          if (!id) return yield { type: 'error', message: 'id is required' };
          const ok = await store.removeTrigger(id);
          if (!ok) return yield { type: 'error', message: 'no such trigger' };
          yield { type: 'result', value: { deleted: true, id } };
        },
      },
    },
  ];
}
