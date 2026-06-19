// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices, ToolContext } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makeDriveTools } from './tools.js';

// Optional integration with the eidan secrets catalog (@eidandev/vault-postgres): declare the
// credentials this plugin needs so Settings → Connections renders a secure section for them.
// Structurally re-declared (matbot registry idiom) so the bundle needs no hard dep on core.
interface SecretField { name: string; label: string; secret?: boolean; required?: boolean; help?: string }
interface SecretSection { plugin: string; title: string; fields: SecretField[] }
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    EidanSecrets?: { declareSection(section: SecretSection): void };
  }
}

// Cross-plugin sharing (matbot service-registry idiom): consume the connected Google account the
// `google`/Gmail plugin registers under GoogleConnection, so one connected account serves both.
// Structurally re-declared so this bundle needs no hard dep on the google package; the string
// service key matches at runtime.
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    GoogleConnection?: { resolveCreds(ctx: ToolContext): Promise<{ clientId: string; clientSecret: string; refreshToken: string } | null> };
  }
}

// eidan `gdrive` plugin: read the operator's Google Drive via OAuth2. It resolves the connected
// Google account from the shared GoogleConnection service the `google` (Gmail) plugin registers
// (the per-account `plugin_google.accounts` registry + vaulted client/refresh token), so a single
// connected Google account serves both — the only requirement is that the consent grant also carries
// the drive.readonly scope. Falls back to the legacy EIDAN_GOOGLE_* vault keys when no account is
// connected. Read-only; nothing stored.
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Google Drive: read-through Drive access over OAuth2 (gdrive_list_recent, gdrive_search, ' +
      'gdrive_read_file), refreshing a short-lived token per call from the connected Google account ' +
      'shared with the Gmail plugin (legacy EIDAN_GOOGLE_* secrets as fallback; requires the ' +
      'drive.readonly scope).',
  },
  async setup(services: MatbotServices) {
    const tools = makeDriveTools({
      resolveShared: (ctx) => services.GoogleConnection?.resolveCreds(ctx) ?? Promise.resolve(null),
    });
    for (const t of tools) services.tools.register(t);
    services.EidanSecrets?.declareSection({
      plugin: 'gdrive',
      title: 'Google Drive',
      fields: [
        { name: 'EIDAN_GOOGLE_CLIENT_ID', label: 'OAuth client ID', help: 'Legacy fallback only — prefer connecting a Google account under Connections (Gmail). From Google Cloud Console → Credentials.' },
        { name: 'EIDAN_GOOGLE_CLIENT_SECRET', label: 'OAuth client secret', secret: true },
        { name: 'EIDAN_GOOGLE_REFRESH_TOKEN', label: 'OAuth refresh token', secret: true, help: 'Legacy fallback only. From the OAuth consent flow; the grant must include the drive.readonly scope (alongside gmail.readonly if Gmail is also used).' },
      ],
    });
  },
};
