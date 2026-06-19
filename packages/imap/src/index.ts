// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { Db } from './db.js';
import { makeMailTools } from './tools.js';

// Optional integration with the eidan secrets catalog (@eidandev/vault-postgres): declare the
// legacy single-account credentials so Settings → Connections still renders them. Named multi-account
// management lives in the Integrations → Mail screen (frontend manifest) and seals only the passwords.
// Structurally re-declared (matbot registry idiom) so the bundle needs no hard dep on core.
interface SecretField { name: string; label: string; secret?: boolean; required?: boolean; help?: string }
interface SecretSection { plugin: string; title: string; fields: SecretField[] }
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    EidanSecrets?: { declareSection(section: SecretSection): void };
  }
}

// eidan `imap` plugin: email as agent input + output. Read-through IMAP (list/search/read,
// read-only) plus SMTP send, over the operator's named mail accounts. Each account's non-secret
// connection fields live in plugin_imap.accounts (managed in the Integrations → Mail screen); only
// the passwords are sealed in the vault. Falls back to the legacy env account (EIDAN_IMAP_* /
// EIDAN_SMTP_*) when no account is registered. Nothing is stored beyond the registry.
let db: Db | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'IMAP mail: read-through inbox access (imap_list_recent/imap_search/imap_read_message) + ' +
      "SMTP send (mail_send), over the operator's named mail accounts (managed in Integrations → " +
      'Mail; passwords sealed in the vault, per-user). Legacy single-account env config still works.',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) {
      throw new Error(
        'EIDAN_DATABASE_URL (or DATABASE_URL) must be set for @eidandev/imap (it owns the plugin_imap account registry)',
      );
    }
    db = new Db(url);
    await db.ensureSchema();
    for (const tool of makeMailTools(db)) services.tools.register(tool);

    services.EidanSecrets?.declareSection({
      plugin: 'imap',
      title: 'Email (legacy single account — IMAP read + SMTP send)',
      fields: [
        { name: 'EIDAN_IMAP_HOST', label: 'IMAP host', help: 'e.g. imap.gmail.com' },
        { name: 'EIDAN_IMAP_USERNAME', label: 'IMAP username' },
        { name: 'EIDAN_IMAP_PASSWORD', label: 'IMAP password', secret: true, help: 'Use an app password if the provider requires it.' },
        { name: 'EIDAN_IMAP_PORT', label: 'IMAP port', help: 'Optional; defaults to 993 (TLS).' },
        { name: 'EIDAN_SMTP_HOST', label: 'SMTP host', help: 'For mail_send; e.g. smtp.gmail.com' },
        { name: 'EIDAN_SMTP_USERNAME', label: 'SMTP username' },
        { name: 'EIDAN_SMTP_PASSWORD', label: 'SMTP password', secret: true },
        { name: 'EIDAN_SMTP_PORT', label: 'SMTP port', help: 'Optional; e.g. 587.' },
        { name: 'EIDAN_SMTP_FROM', label: 'From address', help: 'Optional; defaults to the SMTP username.' },
      ],
    });
  },
  async teardown() {
    if (db) await db.close();
  },
};
