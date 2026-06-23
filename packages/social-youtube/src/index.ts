// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makeYouTubeTools } from './tools.js';

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
      'YouTube: search videos, upload metadata, and view channel (youtube_search, youtube_upload, youtube_channel) via YouTube API with OAuth and matbot vault secrets.',
  },
  async setup(services: MatbotServices) {
    const tools = makeYouTubeTools();
    for (const t of tools) services.tools.register(t);

    services.EidanSecrets?.declareSection({
      plugin: 'social-youtube',
      title: 'YouTube',
      fields: [
        {
          name: 'YOUTUBE_API_KEY',
          label: 'API Key',
          secret: false,
          help: 'Public API key for search functionality (not technically a secret, but rate-limited per key). Generate at https://console.cloud.google.com',
        },
        {
          name: 'YOUTUBE_ACCESS_TOKEN',
          label: 'Access Token',
          secret: true,
          required: true,
          help: '⚠️ OAuth access token for upload and channel access. Requires youtube.upload and youtube.readonly scopes. Your app must pass Google OAuth consent review. Treat as highly sensitive.',
        },
      ],
    });

    console.log('[social-youtube] plugin loaded: youtube_search, youtube_upload, youtube_channel');
  },
};
