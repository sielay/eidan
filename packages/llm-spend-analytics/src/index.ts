// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makeSpendAnalyticsTools } from './tools.js';

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
      'LLM Spend Analytics: trailing-30-day cloud spend breakdown (openrouter_spend_analytics operational; anthropic_spend_analytics and openai_spend_analytics planned) with cache hit rates, spend by model, and 7-day/30-day trends for hardware buy-decision evaluation.',
  },
  async setup(services: MatbotServices) {
    const tools = makeSpendAnalyticsTools();
    for (const t of tools) services.tools.register(t);

    services.EidanSecrets?.declareSection({
      plugin: 'llm-spend-analytics',
      title: 'LLM Spend Analytics',
      fields: [
        {
          name: 'OPENROUTER_API_KEY',
          label: 'OpenRouter API key',
          secret: true,
          required: false,
          help: 'Optional. Get from https://openrouter.ai/keys — used by openrouter_spend_analytics tool.',
        },
        {
          name: 'ANTHROPIC_API_KEY',
          label: 'Anthropic API key',
          secret: true,
          required: false,
          help: 'Optional. Get from https://console.anthropic.com/account/keys — used by anthropic_spend_analytics tool.',
        },
        {
          name: 'OPENAI_API_KEY',
          label: 'OpenAI API key',
          secret: true,
          required: false,
          help: 'Optional. Get from https://platform.openai.com/account/api-keys — used by openai_spend_analytics tool.',
        },
      ],
    });

    console.log(
      '[llm-spend-analytics] plugin loaded: openrouter_spend_analytics (anthropic_spend_analytics and openai_spend_analytics planned)'
    );
  },
};
