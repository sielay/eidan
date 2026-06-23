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
      'X (Twitter) Social: post tweets, search, read profile, and list timeline (x_post_tweet, x_search, x_get_profile, x_list_timeline) via X API v2 with OAuth2 bearer token and matbot vault secrets.',
  },
  async setup(services: MatbotServices) {
    const tools = makeXTools();
    for (const t of tools) services.tools.register(t);

    services.EidanSecrets?.declareSection({
      plugin: 'social-x',
      title: 'X (Twitter) Social',
      fields: [
        {
          name: 'X_ACCESS_TOKEN',
          label: 'X API Access Token',
          secret: true,
          required: true,
          help: 'OAuth2 bearer token from X API v2. Generate at https://developer.twitter.com/en/portal/dashboard with read+write permissions.',
        },
      ],
    });

    console.log('[social-x] plugin loaded: x_post_tweet, x_search, x_get_profile, x_list_timeline');
  },
};
