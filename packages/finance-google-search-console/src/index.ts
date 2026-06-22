// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices, ToolContext } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makeGscTools } from './tools.js';

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
      'Google Search Console finance plugin: performance metrics, sitemaps, indexing status, and crawl errors (gsc_performance, gsc_sitemaps, gsc_indexing_status, gsc_indexing_errors) via the Google Search Console API with OAuth2 and matbot vault secrets.',
  },
  async setup(services: MatbotServices) {
    const tools = makeGscTools();
    for (const t of tools) services.tools.register(t);

    services.EidanSecrets?.declareSection({
      plugin: 'finance-google-search-console',
      title: 'Google Search Console',
      fields: [
        {
          name: 'GSC_ACCESS_TOKEN',
          label: 'OAuth2 Access Token',
          secret: true,
          required: true,
          help: 'OAuth2 access token with Google Search Console scope (searchconsole.googleapis.com). Generate at https://myaccount.google.com/permissions.',
        },
        {
          name: 'GSC_PROPERTY_URL',
          label: 'Property URL',
          required: true,
          help: 'The site/property URL registered in Google Search Console (e.g., https://example.com or https://m.example.com).',
        },
      ],
    });

    console.log('[finance-google-search-console] plugin loaded: gsc_performance, gsc_sitemaps, gsc_indexing_status, gsc_indexing_errors');
  },
};
