// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION, currentPrincipal } from '@matatbread/matbot-plugin-api';
import { startA2AServer } from './server.js';

let stop: (() => void) | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'Inbound A2A server: exposes eidan as an A2A agent (public agent card + message/send) so other agents can delegate to it. The 3rd interop boundary after MCP + AG-UI. Auth via the WebPrincipalResolver.',
  },
  async setup(services: MatbotServices) {
    services.registerFrontend({ name: 'a2a-server' });
    const port = Number(process.env['MATBOT_A2A_PORT'] ?? 8095);
    const provider = process.env['EIDAN_A2A_PROVIDER'] ?? process.env['EIDAN_JOB_PROVIDER'] ?? 'claude';
    const name = process.env['EIDAN_A2A_NAME'] ?? 'eidan';
    const url = process.env['EIDAN_A2A_URL'] ?? `http://localhost:${port}/a2a`;
    const boot = currentPrincipal();
    stop = startA2AServer(services, { port, provider, name, description: 'eidan personal agent — converse and read/write relational memory.', url }, boot);
    console.log(`[a2a-server] on :${port} (agent=${name})`);
  },
  async teardown() {
    if (stop) stop();
  },
};
