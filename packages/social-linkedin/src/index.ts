// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makeLinkedInTools } from './tools.js';

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
      'LinkedIn: post to LinkedIn, search posts, and view profile (linkedin_post, linkedin_search, linkedin_profile) via LinkedIn API OAuth and matbot vault secrets.',
  },
  async setup(services: MatbotServices) {
    const tools = makeLinkedInTools();
    for (const t of tools) services.tools.register(t);

    services.EidanSecrets?.declareSection({
      plugin: 'social-linkedin',
      title: 'LinkedIn',
      fields: [
        {
          name: 'LINKEDIN_ACCESS_TOKEN',
          label: 'Access Token',
          secret: true,
          required: true,
          help: '⚠️ OAuth access token for LinkedIn API (w_member_social scope required). Your app must pass LinkedIn app review. Generate at https://www.linkedin.com/developers. Treat as highly sensitive.',
        },
        {
          name: 'LINKEDIN_USER_ID',
          label: 'User ID',
          required: true,
          help: 'Your LinkedIn numeric user ID.',
        },
      ],
    });

    console.log('[social-linkedin] plugin loaded: linkedin_post, linkedin_search, linkedin_profile');
  },
};
