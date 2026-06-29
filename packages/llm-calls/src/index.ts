// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { Db } from './db.js';
import { LlmCallsImpl, type LlmCalls } from './llm-calls.js';
import { observerTool } from './observer-tool.js';
import { makeVendorResolver } from './vendor.js';
import { ProviderSpendStore } from './spend-store.js';
import { recordProviderSpendTool } from './spend-tool.js';

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    LlmCalls?: LlmCalls;
  }
}

let db: Db | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'LLM cost/usage ledger: records per-provider-call tokens + cost to eidan.llm_calls. Frontends call services.LlmCalls?.record() on each usage event. Also exposes the read-only `observer` tool: deterministic token/agent/cost/efficiency rollups over the ledger (no LLM inference).',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) { console.warn('[llm-calls] no EIDAN_DATABASE_URL — ledger disabled'); return; }
    db = new Db(url);
    await services.register('LlmCalls', new LlmCallsImpl(db));
    const spendStore = new ProviderSpendStore(db);
    services.tools.register(observerTool(db, makeVendorResolver(services), spendStore));
    services.tools.register(recordProviderSpendTool(spendStore));
    console.log('[llm-calls] ledger ready');
  },
  async teardown() {
    if (db) await db.close();
  },
};
