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
      '⚠️ UNOFFICIAL: Google Trends (search trends, top charts, rising queries) via reverse-engineered endpoints. Subject to breakage without notice. Consider SerpAPI or ValueSerps for production use. (google_trends_search, google_trends_topics, google_trends_rising)',
  },
  async setup(services: MatbotServices) {
    const tools = makeGoogleTrendsTools();
    for (const t of tools) services.tools.register(t);

    services.EidanSecrets?.declareSection({
      plugin: 'finance-google-trends',
      title: 'Google Trends (⚠️ Unofficial)',
      fields: [
        {
          name: 'GOOGLE_TRENDS_API_KEY',
          label: 'API Key (for reverse-engineered endpoints)',
          secret: true,
          required: true,
          help: '⚠️ WARNING: Google Trends API is not officially public. These endpoints are reverse-engineered and subject to change or breakage without notice. For production use, consider third-party services like SerpAPI or ValueSerps.',
        },
      ],
    });

    console.log('[finance-google-trends] ⚠️ plugin loaded (unofficial API): google_trends_search, google_trends_topics, google_trends_rising');
  },
};
