// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION, currentPrincipal } from '@matatbread/matbot-plugin-api';
import { startAguiServer } from './server.js';

let stop: (() => void) | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'AG-UI frontend: exposes POST /api/turn (AG-UI SSE) + POST /api/conversations for the eidan Next.js app. The engine-side chat surface; matbot frontend-web stays dev/demo only.',
  },
  async setup(services: MatbotServices) {
    services.registerFrontend({ name: 'frontend-agui' });
    const port = Number(process.env['MATBOT_AGUI_PORT'] ?? 8090);
    const provider = process.env['EIDAN_AGUI_PROVIDER'] ?? process.env['EIDAN_JOB_PROVIDER'] ?? 'claude';
    const boot = currentPrincipal(); // established at boot before plugins load
    stop = startAguiServer(services, port, provider, boot);
    console.log(`[frontend-agui] AG-UI server on :${port} (provider=${provider})`);
  },
  async teardown() {
    if (stop) stop();
  },
};
