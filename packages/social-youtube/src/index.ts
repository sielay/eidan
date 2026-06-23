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
      'YouTube Social: post comments, search videos, and get channel info (youtube_post_comment, youtube_search, youtube_get_channel, youtube_list_videos) via YouTube Data API v3 with OAuth2 and matbot vault secrets.',
  },
  async setup(services: MatbotServices) {
    const tools = makeYouTubeTools();
    for (const t of tools) services.tools.register(t);

    services.EidanSecrets?.declareSection({
      plugin: 'social-youtube',
      title: 'YouTube Social',
      fields: [
        {
          name: 'YOUTUBE_ACCESS_TOKEN',
          label: 'Access Token',
          secret: true,
          help: 'OAuth2 access token for YouTube Data API v3. Generate via Google Cloud Console (OAuth 2.0 credentials).',
        },
      ],
    });

    console.log('[social-youtube] plugin loaded: youtube_post_comment, youtube_search, youtube_get_channel, youtube_list_videos');
  },
};
