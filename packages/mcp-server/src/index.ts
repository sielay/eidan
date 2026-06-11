// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices, Principal } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { startMcpServer } from './server.js';

let stop: (() => void) | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'Inbound MCP server: exposes a curated set of eidan tools over MCP (JSON-RPC/HTTP) so external agents (Claude Code, other MCP clients) can use eidan memory. Auth: Bearer (WebPrincipalResolver) or X-MCP-Secret. Exposed tools via EIDAN_MCP_TOOLS (default remember,recall; "*" = all).',
  },
  async setup(services: MatbotServices) {
    services.registerFrontend({ name: 'mcp-server' });
    const port = Number(process.env['MATBOT_MCP_PORT'] ?? 8091);
    const secret = process.env['EIDAN_MCP_SECRET'];
    const secretPrincipalId = process.env['EIDAN_MCP_PRINCIPAL'];
    const secretPrincipal: Principal | undefined = secret && secretPrincipalId ? { id: secretPrincipalId, type: 'user' } : undefined;
    const allowEnv = (process.env['EIDAN_MCP_TOOLS'] ?? 'remember,recall').trim();
    const allowAll = allowEnv === '*';
    const allowSet = new Set(allowEnv.split(',').map((s) => s.trim()).filter(Boolean));
    const allow = (name: string): boolean => allowAll || allowSet.has(name);

    stop = startMcpServer(services, {
      port,
      allow,
      ...(secret !== undefined ? { secret } : {}),
      ...(secretPrincipal !== undefined ? { secretPrincipal } : {}),
    });
    console.log(`[mcp-server] on :${port} exposing tools [${allowAll ? '*' : [...allowSet].join(',')}]`);
  },
  async teardown() {
    if (stop) stop();
  },
};
