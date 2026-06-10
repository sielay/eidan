// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IncomingMessage } from 'node:http';
import type { MatbotPluginSpec, MatbotServices, Principal } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { verifyHs256 } from './jwt.js';

// Same key matbot's frontend-web + @eidandev/frontend-agui consume.
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    WebPrincipalResolver?: (req: IncomingMessage) => Principal | Promise<Principal>;
  }
}

export class UnauthorizedError extends Error {}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'eidan engine auth: registers a WebPrincipalResolver deriving the per-request Principal from a Bearer JWT (HS256, shared secret). Sign-in lives in the Next.js app; the engine only verifies.',
  },
  async setup(services: MatbotServices) {
    const secret = process.env['EIDAN_AUTH_JWT_SECRET'] ?? process.env['EIDAN_AUTH_MASTER_KEY'];
    if (!secret) {
      console.warn('[auth] no EIDAN_AUTH_JWT_SECRET / EIDAN_AUTH_MASTER_KEY — resolver NOT registered (boot principal in use)');
      return;
    }
    await services.register('WebPrincipalResolver', (req: IncomingMessage): Principal => {
      const auth = req.headers['authorization'];
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      const claims = token ? verifyHs256(token, secret) : null;
      if (!claims || typeof claims.sub !== 'string' || claims.sub === '') {
        throw new UnauthorizedError('missing or invalid bearer token');
      }
      return { id: claims.sub, type: 'user' };
    });
    console.log('[auth] WebPrincipalResolver registered (HS256 bearer)');
  },
};
