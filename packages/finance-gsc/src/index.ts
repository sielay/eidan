// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makeGSCTools } from './tools.js';

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
      'Google Search Console: get performance metrics, sitemaps, and indexing status (gsc_performance, gsc_sitemaps, gsc_indexing) via Google Search Console API with OAuth and matbot vault secrets.',
  },
  async setup(services: MatbotServices) {
    const tools = makeGSCTools();
    for (const t of tools) services.tools.register(t);

    services.EidanSecrets?.declareSection({
      plugin: 'finance-gsc',
      title: 'Google Search Console',
      fields: [
        {
          name: 'GSC_ACCESS_TOKEN',
          label: 'Access Token',
          secret: true,
          required: true,
          help: 'OAuth access token for Google Search Console API. Generate at https://search.google.com/search-console',
        },
      ],
    });

    console.log('[finance-gsc] plugin loaded: gsc_performance, gsc_sitemaps, gsc_indexing');
  },
};
