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
      'Mastodon Social: post toots, search posts, get profiles, and read timelines (mastodon_post, mastodon_search, mastodon_get_profile, mastodon_list_timeline) via Mastodon API with bearer token auth and matbot vault secrets.',
  },
  async setup(services: MatbotServices) {
    const tools = makeMastodonTools();
    for (const t of tools) services.tools.register(t);

    services.EidanSecrets?.declareSection({
      plugin: 'social-mastodon',
      title: 'Mastodon Social',
      fields: [
        {
          name: 'MASTODON_INSTANCE',
          label: 'Mastodon Instance',
          help: 'Your Mastodon instance domain (e.g., mastodon.social, fosstodon.org, or your custom domain).',
        },
        {
          name: 'MASTODON_ACCESS_TOKEN',
          label: 'Access Token',
          secret: true,
          help: 'OAuth2 access token. Generate at Settings → Development → New Application, then authorize and copy the token.',
        },
      ],
    });

    console.log('[social-mastodon] plugin loaded: mastodon_post, mastodon_search, mastodon_get_profile, mastodon_list_timeline');
  },
};
