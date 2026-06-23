// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makeXTools } from './tools.js';

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
      '⚠️ X (Twitter) API: Post/search/profile tools. POST requires OAuth 1.0a User Context (not fully implemented). Read operations (search, profile) use OAuth 2.0 Bearer (app-only, limited scope).',
  },
  async setup(services: MatbotServices) {
    const tools = makeXTools();
    for (const t of tools) services.tools.register(t);

    services.EidanSecrets?.declareSection({
      plugin: 'social-x',
      title: 'X (Twitter)',
      fields: [
        {
          name: 'X_ACCESS_TOKEN',
          label: 'Access Token (Read-only)',
          secret: true,
          required: true,
          help: '⚠️ Bearer token for X API v2 read operations only (OAuth 2.0). POST operations require OAuth 1.0a User Context (not yet implemented). Generate at https://developer.twitter.com',
        },
      ],
    });

    console.log('[social-x] ⚠️ plugin loaded (POST not fully supported): x_post, x_search, x_profile');
  },
};
