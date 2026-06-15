// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool, JSONSchema } from '@matatbread/matbot-plugin-api';
import { RoutinesStore, type RoutineRow } from './store.js';
import { isValidSchedule } from './schedule.js';

const SCHEDULE_HELP =
  'When to run, in the owner\'s timezone: "HH:MM" for every day (e.g. "08:00"), or "<days> HH:MM" ' +
  'for specific weekdays (e.g. "mon,wed,fri 08:00" or "sun 20:00"). Days are mon/tue/wed/thu/fri/sat/sun.';

function view(r: RoutineRow): Record<string, unknown> {
  return {
    id: r.id, name: r.name, schedule: r.schedule, prompt: r.prompt,
    enabled: r.enabled, last_run_at: r.last_run_at,
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

const CREATE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short label for the routine (e.g. "Morning briefing").', minLength: 1 },
    schedule: { type: 'string', description: SCHEDULE_HELP, minLength: 1 },
    prompt: { type: 'string', description: 'The instruction to run as an agent turn when due (e.g. "Summarise my calendar and unread email for today").', minLength: 1 },
  },
  required: ['name', 'schedule', 'prompt'],
  additionalProperties: false,
};

const LIST_SCHEMA: JSONSchema = { type: 'object', properties: {}, additionalProperties: false };

const UPDATE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'The routine to change.', minLength: 1 },
    name: { type: 'string', description: 'New label; omit to leave unchanged.', minLength: 1 },
    schedule: { type: 'string', description: `New schedule; omit to leave unchanged. ${SCHEDULE_HELP}`, minLength: 1 },
    prompt: { type: 'string', description: 'New instruction; omit to leave unchanged.', minLength: 1 },
    enabled: { type: 'boolean', description: 'Pause (false) or resume (true) the routine; omit to leave unchanged.' },
  },
  required: ['id'],
  additionalProperties: false,
};

const DELETE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: { id: { type: 'string', description: 'The routine to delete.', minLength: 1 } },
  required: ['id'],
  additionalProperties: false,
};

export function buildRoutineTools(store: RoutinesStore): Tool[] {
  return [
    {
      name: 'routine_create',
      description:
        'Schedule a recurring prompt for the operator — it runs automatically on the given cadence ' +
        'and the result is delivered to their notification channel. Use when they ask for something ' +
        'regular ("every morning brief me", "remind me to review goals on Sundays").',
      inputSchema: CREATE_SCHEMA,
      executor: {
        async *execute(input) {
          const args = (input ?? {}) as Record<string, unknown>;
          const name = str(args['name']).trim();
          const schedule = str(args['schedule']).trim();
          const prompt = str(args['prompt']).trim();
          if (!name || !schedule || !prompt) return yield { type: 'error', message: 'name, schedule and prompt are required' };
          if (!isValidSchedule(schedule)) {
            return yield { type: 'error', message: `invalid schedule "${schedule}". ${SCHEDULE_HELP}` };
          }
          const row = await store.create({ name, schedule, prompt });
          yield { type: 'result', value: view(row) };
        },
      },
    },
    {
      name: 'routine_list',
      description: "List the operator's scheduled routines (name, schedule, prompt, enabled, last run). Use to recall or review what is scheduled before adding or changing one.",
      inputSchema: LIST_SCHEMA,
      executor: {
        async *execute() {
          const rows = await store.list();
          yield { type: 'result', value: { routines: rows.map(view) } };
        },
      },
    },
    {
      name: 'routine_update',
      description: "Change a routine — rename it, reschedule it, edit its prompt, or pause/resume it (enabled). Only the fields you pass change. Use when the operator adjusts an existing routine.",
      inputSchema: UPDATE_SCHEMA,
      executor: {
        async *execute(input) {
          const args = (input ?? {}) as Record<string, unknown>;
          const id = str(args['id']).trim();
          if (!id) return yield { type: 'error', message: 'id is required' };
          const patch: { name?: string; schedule?: string; prompt?: string; enabled?: boolean } = {};
          if (args['name'] !== undefined) { const v = str(args['name']).trim(); if (!v) return yield { type: 'error', message: 'name cannot be blank' }; patch.name = v; }
          if (args['schedule'] !== undefined) {
            const v = str(args['schedule']).trim();
            if (!isValidSchedule(v)) return yield { type: 'error', message: `invalid schedule "${v}". ${SCHEDULE_HELP}` };
            patch.schedule = v;
          }
          if (args['prompt'] !== undefined) { const v = str(args['prompt']).trim(); if (!v) return yield { type: 'error', message: 'prompt cannot be blank' }; patch.prompt = v; }
          if (typeof args['enabled'] === 'boolean') patch.enabled = args['enabled'];
          const row = await store.update(id, patch);
          if (!row) return yield { type: 'error', message: 'no such routine' };
          yield { type: 'result', value: view(row) };
        },
      },
    },
    {
      name: 'routine_delete',
      description: 'Delete a routine so it no longer runs. Use when the operator no longer wants a scheduled prompt.',
      inputSchema: DELETE_SCHEMA,
      executor: {
        async *execute(input) {
          const args = (input ?? {}) as Record<string, unknown>;
          const id = str(args['id']).trim();
          if (!id) return yield { type: 'error', message: 'id is required' };
          const ok = await store.remove(id);
          if (!ok) return yield { type: 'error', message: 'no such routine' };
          yield { type: 'result', value: { deleted: true, id } };
        },
      },
    },
  ];
}
