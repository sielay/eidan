// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices, ToolContext } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makeBlueskyTools } from './tools.js';

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
      'Bluesky Social: post to Bluesky, search posts, and read your feed (bluesky_post, bluesky_search, bluesky_read_feed) via AT Protocol with app-password OAuth and matbot vault secrets.',
  },
  async setup(services: MatbotServices) {
    const tools = makeBlueskyTools();
    for (const t of tools) services.tools.register(t);

    services.EidanSecrets?.declareSection({
      plugin: 'social-bluesky',
      title: 'Bluesky Social',
      fields: [
        {
          name: 'BLUESKY_HANDLE',
          label: 'Bluesky Handle',
          help: 'Your Bluesky handle (e.g., user.bsky.social or custom domain). From bsky.app/settings/identity.',
        },
        {
          name: 'BLUESKY_APP_PASSWORD',
          label: 'App Password',
          secret: true,
          help: 'App password (NOT your login password). Generate at https://bsky.app/settings/app-passwords',
        },
        {
          name: 'BLUESKY_SERVICE',
          label: 'Service URL',
          help: 'Optional: custom AT Protocol service (default: https://bsky.social)',
        },
      ],
    });

    console.log('[social-bluesky] plugin loaded: bluesky_post, bluesky_search, bluesky_read_feed');
  },
};
