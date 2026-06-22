// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makeMastodonTools } from './tools.js';

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
      'Mastodon: post to Mastodon, search posts, and view profile (mastodon_post, mastodon_search, mastodon_profile) via Mastodon API with bearer token and matbot vault secrets.',
  },
  async setup(services: MatbotServices) {
    const tools = makeMastodonTools();
    for (const t of tools) services.tools.register(t);

    services.EidanSecrets?.declareSection({
      plugin: 'social-mastodon',
      title: 'Mastodon',
      fields: [
        {
          name: 'MASTODON_INSTANCE_URL',
          label: 'Instance URL',
          required: true,
          help: 'URL of your Mastodon instance (e.g., https://mastodon.social)',
        },
        {
          name: 'MASTODON_ACCESS_TOKEN',
          label: 'Access Token',
          secret: true,
          required: true,
          help: 'OAuth access token for Mastodon API. Generate in Preferences > Development > New application.',
        },
      ],
    });

    console.log('[social-mastodon] plugin loaded: mastodon_post, mastodon_search, mastodon_profile');
  },
};
