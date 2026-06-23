// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices, ToolContext } from '@matatbread/matbot-plugin-api';
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
      'Facebook Social: post to Facebook, search posts, read feed, and get profile (facebook_post_feed, facebook_search, facebook_get_profile, facebook_list_feed) via Facebook Graph API with OAuth2 token and matbot vault secrets.',
  },
  async setup(services: MatbotServices) {
    const tools = makeFacebookTools();
    for (const t of tools) services.tools.register(t);

    services.EidanSecrets?.declareSection({
      plugin: 'social-facebook',
      title: 'Facebook Social',
      fields: [
        {
          name: 'FACEBOOK_ACCESS_TOKEN',
          label: 'Access Token',
          secret: true,
          required: true,
          help: 'Long-lived OAuth2 access token. Generate at https://developers.facebook.com/tools/explorer or via app permissions.',
        },
        {
          name: 'FACEBOOK_PAGE_ID',
          label: 'Page ID (Optional)',
          help: 'Facebook Page ID to post as a page instead of personal profile. Leave blank to post to personal feed.',
        },
      ],
    });

    console.log('[social-facebook] plugin loaded: facebook_post_feed, facebook_search, facebook_get_profile, facebook_list_feed');
  },
};
