// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices, ToolContext } from '@matatbread/matbot-plugin-api';
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
      'LinkedIn Social: post to LinkedIn, search posts, get profile info, and read your feed (linkedin_post, linkedin_search, linkedin_get_profile, linkedin_list_feed) via OAuth2 with matbot vault secrets.',
  },
  async setup(services: MatbotServices) {
    const tools = makeLinkedInTools();
    for (const t of tools) services.tools.register(t);

    services.EidanSecrets?.declareSection({
      plugin: 'social-linkedin',
      title: 'LinkedIn Social',
      fields: [
        {
          name: 'LINKEDIN_ACCESS_TOKEN',
          label: 'Access Token',
          secret: true,
          required: true,
          help: 'OAuth2 access token for LinkedIn API. Generate via LinkedIn developer app at https://www.linkedin.com/developers/apps',
        },
        {
          name: 'LINKEDIN_ALLOWED_IMAGE_DOMAINS',
          label: 'Additional Image Domains',
          secret: false,
          required: false,
          help: 'Comma-separated list of additional trusted domains for image uploads (e.g., "mycdn.example.com, images.example.org"). Domains are case-insensitive and support subdomains.',
        },
      ],
    });

    console.log(
      '[social-linkedin] plugin loaded: linkedin_post, linkedin_search, linkedin_get_profile, linkedin_list_feed'
    );
  },
};
