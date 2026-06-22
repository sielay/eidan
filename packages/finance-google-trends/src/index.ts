// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makeGoogleTrendsTools } from './tools.js';

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
      'Google Trends Finance: search volume trends, top charts, rising queries, and related searches (google_trends_search, google_trends_top_charts, google_trends_rising_queries, google_trends_related) via Google Trends public API.',
  },
  async setup(services: MatbotServices) {
    const tools = makeGoogleTrendsTools();
    for (const t of tools) services.tools.register(t);

    services.EidanSecrets?.declareSection({
      plugin: 'finance-google-trends',
      title: 'Google Trends',
      fields: [
        {
          name: 'GOOGLE_TRENDS_API_KEY',
          label: 'API Key (Optional)',
          secret: true,
          help: 'Optional: API key for Google Trends wrapper service (if using paid endpoints). Default uses public API.',
        },
      ],
    });

    console.log(
      '[finance-google-trends] plugin loaded: google_trends_search, google_trends_top_charts, google_trends_rising_queries, google_trends_related'
    );
  },
};
