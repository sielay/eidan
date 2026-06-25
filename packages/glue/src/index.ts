// SPDX-License-Identifier: AGPL-3.0-or-later
// eidan `glue` plugin: a thin adapter onto the operator's Glue marketing suite
// (potem apps/glue-web), consumed over its MCP server. Four capability tools —
// analytics, funnels, subscriber lists, and email campaigns — proxy to Glue's
// MCP; eidan stores nothing locally (pull, don't duplicate). Configure via the
// vault (Settings → Glue marketing): EIDAN_GLUE_MCP_URL (the Glue /api/mcp
// endpoint) + GLUE_MCP_SECRET (Glue's X-MCP-Secret) — both DB-backed, so they
// reach every node with no per-node env. It is the first reference adapter for the
// marketing capability surface; a vendor-neutral interface can grow over it
// later when a second provider appears.
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makeGlueTools } from './tools.js';

// Re-declared (matbot registry idiom) so the plugin needs no hard dep on core's vault implementation.
interface SecretField { name: string; label: string; secret?: boolean; required?: boolean; help?: string }
interface SecretSection { plugin: string; title: string; fields: SecretField[] }
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    EidanSecrets?: {
      declareSection(section: SecretSection): void;
      setSecret(name: string, value: string): Promise<void>;
    };
  }
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Glue marketing adapter: analytics, funnels, subscriber lists, and email campaigns ' +
      '(glue_analytics, glue_funnels, glue_lists, glue_campaigns) driven over the operator\'s ' +
      'Glue MCP server. Configure EIDAN_GLUE_MCP_URL + GLUE_MCP_SECRET in the vault.',
  },
  async setup(services: MatbotServices) {
    for (const tool of makeGlueTools()) services.tools.register(tool);

    services.EidanSecrets?.declareSection({
      plugin: 'glue',
      title: 'Glue marketing',
      fields: [
        {
          name: 'EIDAN_GLUE_MCP_URL',
          label: 'Glue MCP endpoint URL',
          secret: false,
          required: true,
          help: 'The Glue MCP endpoint, e.g. https://glue.example.com/api/mcp. Stored in the vault — reaches every node, no per-node env needed.',
        },
        {
          name: 'GLUE_MCP_SECRET',
          label: 'Glue MCP secret (X-MCP-Secret)',
          secret: true,
          required: true,
          help: "Glue's MCP_GLUE_SECRET. Stored in the vault alongside the endpoint URL.",
        },
      ],
    });

    console.log('[glue] plugin loaded');
  },
};
