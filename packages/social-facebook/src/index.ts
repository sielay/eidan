// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makeFacebookTools } from './tools.js';

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
      'Facebook: post to Facebook, search posts, and view profile (facebook_post, facebook_search, facebook_profile) via Facebook Graph API with OAuth and matbot vault secrets.',
  },
  async setup(services: MatbotServices) {
    const tools = makeFacebookTools();
    for (const t of tools) services.tools.register(t);

    services.EidanSecrets?.declareSection({
      plugin: 'social-facebook',
      title: 'Facebook',
      fields: [
        {
          name: 'FACEBOOK_ACCESS_TOKEN',
          label: 'Access Token',
          secret: true,
          required: true,
          help: 'OAuth access token for Facebook Graph API. Generate at https://developers.facebook.com',
        },
        {
          name: 'FACEBOOK_USER_ID',
          label: 'User ID',
          required: true,
          help: 'Your numeric Facebook user ID.',
        },
      ],
    });

    console.log('[social-facebook] plugin loaded: facebook_post, facebook_search, facebook_profile');
  },
};
