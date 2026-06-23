// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices, ToolContext } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makeThreadsTools } from './tools.js';

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
      'Threads Social: post to Threads, search posts, get profile, and read timeline (threads_post_thread, threads_search, threads_get_profile, threads_list_timeline) via Meta Threads API with OAuth2 bearer token and matbot vault secrets.',
  },
  async setup(services: MatbotServices) {
    const tools = makeThreadsTools();
    for (const t of tools) services.tools.register(t);

    services.EidanSecrets?.declareSection({
      plugin: 'social-threads',
      title: 'Threads Social',
      fields: [
        {
          name: 'THREADS_ACCESS_TOKEN',
          label: 'Threads Access Token',
          secret: true,
          required: true,
          help: 'OAuth2 access token for Meta Threads API. Get from https://developers.facebook.com/docs/threads/get-started',
        },
      ],
    });

    console.log('[social-threads] plugin loaded: threads_post_thread, threads_search, threads_get_profile, threads_list_timeline');
  },
};
