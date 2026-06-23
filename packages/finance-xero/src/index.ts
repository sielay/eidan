// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { Registry, startOAuthServer, type SealFn } from '@eidandev/connections-kit';
import { makeXeroTools } from './tools.js';
import { xeroAdapter } from './adapter.js';

// Optional integration with the eidan secrets catalog (@eidandev/vault-postgres): the connect flow
// seals secrets through the EidanSecrets service. Structurally re-declared (matbot registry idiom) so
// the plugin needs no hard dep on core; the string service key matches at runtime.
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    EidanSecrets?: {
      declareSection(section: {
        plugin: string;
        title: string;
        fields: { name: string; label: string; secret?: boolean; required?: boolean; help?: string }[];
      }): void;
      setSecret(name: string, value: string): Promise<void>;
    };
  }
}

// eidan `finance-xero` plugin: read the operator's Xero accounting data via OAuth2 on the shared
// connections kit. Organisations are connected in the Connections screen (the plugin's frontend) — the
// OAuth client id/secret, the rotating refresh token and the cached access token are sealed in the
// vault per org, the registry lives in plugin_finance_xero.accounts (tenant id in external_id). Each
// call mints/refreshes a short-lived access token and reads the Xero API. Read-only.
const SCHEMA = 'plugin_finance_xero';
let registry: Registry | undefined;
let stopOAuthServer: (() => void) | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Xero (accounting): read-through access over OAuth2 — xero_invoices, xero_contacts, xero_accounts, ' +
      'xero_bank_transactions, xero_profit_and_loss, xero_balance_sheet, xero_aged_receivables, ' +
      'xero_aged_payables — across the operator\'s connected organisations (managed in the Connections ' +
      'screen; client + rotating tokens sealed in the vault, per-user).',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    const seal: SealFn | undefined = services.EidanSecrets
      ? (name, value) => services.EidanSecrets!.setSecret(name, value)
      : undefined;

    if (url) {
      registry = new Registry(url, { schema: SCHEMA });
      await registry.ensureSchema();
      for (const tool of makeXeroTools(registry, seal)) services.tools.register(tool);

      // Server-side connect/reconnect: the web is a write-only vault client and can't read the sealed
      // OAuth client back to rebuild the consent URL or exchange the code — the engine can. Expose the
      // OAuth endpoints behind the AG-UI panel-proxy.
      const port = Number(process.env['MATBOT_XERO_OAUTH_PORT'] ?? 8108);
      stopOAuthServer = startOAuthServer(services, registry, xeroAdapter, { port, prefix: '/api/me/finance-xero/oauth' });
      console.log(`[finance-xero] plugin loaded (oauth on :${port}): xero_invoices, xero_contacts, xero_accounts, xero_bank_transactions, xero_profit_and_loss, xero_balance_sheet, xero_aged_receivables, xero_aged_payables`);
    } else {
      // No DB: register the tools so they surface a clear "not connected" message rather than vanishing.
      for (const tool of makeXeroTools(null, seal)) services.tools.register(tool);
      console.log('[finance-xero] plugin loaded (no database — connect an org once EIDAN_DATABASE_URL is set)');
    }
  },
  async teardown() {
    if (stopOAuthServer) stopOAuthServer();
    if (registry) await registry.close();
  },
};
