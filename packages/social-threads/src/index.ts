// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
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
      'Threads: post to Threads, search posts, and view profile (threads_post, threads_search, threads_profile) via Threads API with OAuth and matbot vault secrets.',
  },
  async setup(services: MatbotServices) {
    const tools = makeThreadsTools();
    for (const t of tools) services.tools.register(t);

    services.EidanSecrets?.declareSection({
      plugin: 'social-threads',
      title: 'Threads',
      fields: [
        {
          name: 'THREADS_ACCESS_TOKEN',
          label: 'Access Token',
          secret: true,
          required: true,
          help: 'OAuth access token for Threads API. Generate at https://www.threads.net/settings/apps',
        },
        {
          name: 'THREADS_USER_ID',
          label: 'User ID',
          required: true,
          help: 'Your numeric Threads user ID.',
        },
      ],
    });

    console.log('[social-threads] plugin loaded: threads_post, threads_search, threads_profile');
  },
};
