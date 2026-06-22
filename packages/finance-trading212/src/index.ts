// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makeTrading212Tools } from './tools.js';

interface SecretField {
  name: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  help?: string;
}

interface SecretSection {
  plugin: string;
  title: string;
  fields: SecretField[];
}

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    EidanSecrets?: { declareSection(section: SecretSection): void };
  }
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Trading 212 Finance: portfolio holdings, account info, and trade history (trading212_portfolio, trading212_account, trading212_trades) via Trading 212 Public API with Bearer token auth and matbot vault secrets.',
  },
  async setup(services: MatbotServices) {
    const tools = makeTrading212Tools();
    for (const t of tools) services.tools.register(t);

    services.EidanSecrets?.declareSection({
      plugin: 'finance-trading212',
      title: 'Trading 212 Finance',
      fields: [
        {
          name: 'TRADING212_API_KEY',
          label: 'Trading 212 API Key',
          secret: true,
          required: true,
          help: 'Your Trading 212 API key. Generate at https://trading212.com/settings/api',
        },
      ],
    });

    console.log('[finance-trading212] plugin loaded: trading212_portfolio, trading212_account, trading212_trades');
  },
};
