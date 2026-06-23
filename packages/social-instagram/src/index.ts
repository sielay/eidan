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
      'Instagram: post to Instagram, search hashtags, and view profile (instagram_post, instagram_search, instagram_profile) via Instagram Graph API with OAuth and matbot vault secrets.',
  },
  async setup(services: MatbotServices) {
    const tools = makeInstagramTools();
    for (const t of tools) services.tools.register(t);

    services.EidanSecrets?.declareSection({
      plugin: 'social-instagram',
      title: 'Instagram',
      fields: [
        {
          name: 'INSTAGRAM_ACCESS_TOKEN',
          label: 'Access Token',
          secret: true,
          required: true,
          help: '⚠️ OAuth access token for Instagram Graph API (instagram_business_content_publish scope required). Your app must pass Facebook/Instagram app review. Generate at https://developers.facebook.com/instagram. Treat as highly sensitive.',
        },
        {
          name: 'INSTAGRAM_BUSINESS_ACCOUNT_ID',
          label: 'Business Account ID',
          required: true,
          help: 'Your Instagram business account ID.',
        },
      ],
    });

    console.log('[social-instagram] plugin loaded: instagram_post, instagram_search, instagram_profile');
  },
};
