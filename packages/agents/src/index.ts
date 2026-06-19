// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { Db } from './db.js';
import { AgentsStore } from './store.js';
import { buildAgentTools } from './tools.js';
import { startAgentsLoop } from './loop.js';

// Advertise the agents store so other plugins / surfaces can read or manage agents with type safety:
// services.Agents?.listAgents().
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    Agents?: AgentsStore;
  }
}

let db: Db | undefined;
let stop: (() => Promise<void>) | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'eidan agents: an unlimited registry of user-defined agents (persona + their own provider) bound ' +
      'to composable triggers (schedule | sensor | webhook). Registers agent CRUD + agent_schedule tools ' +
      'and a cluster-deduped dispatch loop that runs each due schedule trigger as a turn under the ' +
      'agent\'s provider, links the conversation, and delivers on the "agent" notify topic. Generalises ' +
      '@eidandev/routines; epic sielay/eidan#346 (schedule trigger is slice 1).',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) throw new Error('EIDAN_DATABASE_URL (or DATABASE_URL) must be set for @eidandev/agents');
    db = new Db(url);
    const store = new AgentsStore(db);
    await services.register('Agents', store);
    for (const tool of buildAgentTools(store)) services.tools.register(tool);

    const defaultProvider =
      process.env['EIDAN_AGENT_PROVIDER'] ??
      process.env['EIDAN_AGUI_PROVIDER'] ??
      process.env['EIDAN_JOB_PROVIDER'] ??
      'claude';
    const pollMs = Number(process.env['EIDAN_AGENT_POLL_MS'] ?? '60000');
    const graceMinutes = Number(process.env['EIDAN_AGENT_GRACE_MIN'] ?? '30');
    // Per-fire hard cap (default 4 min — under Node fetch's ~5 min header timeout). A stuck turn aborts
    // and records a failure (which, after a streak, escalates) instead of wedging the loop.
    const turnTimeoutMs = Number(process.env['EIDAN_AGENT_TURN_TIMEOUT_MS'] ?? '240000');
    stop = startAgentsLoop(services, store, { defaultProvider, pollMs, graceMinutes, turnTimeoutMs });
    console.log(`[agents] loop started (defaultProvider=${defaultProvider}, poll=${pollMs}ms, grace=${graceMinutes}m)`);
  },
  async teardown() {
    if (stop) await stop();
    if (db) await db.close();
  },
};
