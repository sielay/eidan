// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makeInstagramTools } from './tools.js';

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
      'Instagram Social: post to Instagram, search hashtags/users, read your feed, and get your profile (instagram_post_feed, instagram_search, instagram_list_feed, instagram_get_profile) via Instagram Graph API with long-lived OAuth2 token and matbot vault secrets.',
  },
  async setup(services: MatbotServices) {
    const tools = makeInstagramTools();
    for (const t of tools) services.tools.register(t);

    services.EidanSecrets?.declareSection({
      plugin: 'social-instagram',
      title: 'Instagram Social',
      fields: [
        {
          name: 'INSTAGRAM_ACCESS_TOKEN',
          label: 'Instagram Graph API Access Token',
          secret: true,
          required: true,
          help: 'Long-lived OAuth2 access token. Generate at https://developers.facebook.com/ by creating an app, setting up Instagram Graph API, and generating a token with instagram_basic,instagram_graph_user_media,instagram_graph_user_profile scopes.',
        },
      ],
    });

    console.log('[social-instagram] plugin loaded: instagram_post_feed, instagram_search, instagram_list_feed, instagram_get_profile');
  },
};
