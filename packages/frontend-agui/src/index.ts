// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION, currentPrincipal } from '@matatbread/matbot-plugin-api';
import { createPanelProxy } from './panel-proxy.js';
import { startAguiServer } from './server.js';

let stop: (() => void) | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'AG-UI frontend: exposes POST /api/turn (AG-UI SSE) + POST /api/conversations for the eidan Next.js app. The engine-side chat surface; matbot frontend-web stays dev/demo only.',
  },
  async setup(services: MatbotServices) {
    services.registerFrontend({ name: 'frontend-agui' });
    // The single public ingress: plugins with their own internal HTTP port register a path prefix
    // here and this server reverse-proxies to them (so only :8090 is exposed). Registered before the
    // server starts; later plugins (secrets-api, bundle panels) add their routes during their setup.
    await services.register('PanelProxy', createPanelProxy());
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
