// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { Db } from './db.js';
import { PostgresVault } from './vault.js';
import { EidanSecretsImpl } from './secrets-service.js';
import type { EidanSecrets } from './secrets-service.js';
import { secretTool } from './tools.js';

export type { EidanSecrets, SecretSection, SecretField, SecretMeta } from './secrets-service.js';

// Advertise the eidan secrets surface so the HTTP frontend (@eidandev/secrets-api) and other
// plugins can manage user secrets with full type safety. The matbot `Vault` is swapped separately
// via register('Vault', …) so every ctx.vault.resolve('${NAME}') reads the encrypted store.
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    EidanSecrets?: EidanSecrets;
  }
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'eidan encrypted secrets vault: replaces the default env vault with a matbot Vault backend over eidan.secrets_vault (Fernet-at-rest, per-user via the ambient Principal); registers the EidanSecrets service (catalog + secure set/delete/metadata) and the value-free `secret` chat tool.',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) throw new Error('EIDAN_DATABASE_URL (or DATABASE_URL) must be set for @eidandev/vault-postgres');
    if (!process.env['EIDAN_AUTH_MASTER_KEY']) {
      throw new Error('EIDAN_AUTH_MASTER_KEY must be set for @eidandev/vault-postgres (it seals secrets at rest)');
    }
    const db = new Db(url);
    const vault = new PostgresVault(db);
    // Swap the active vault backend (env vault -> encrypted DB vault). Capture-safe: every
    // ctx.vault.resolve('${NAME}') from here on reads the encrypted vault, falling back to env.
    await services.register('Vault', vault);

    const secrets = new EidanSecretsImpl(db, vault);
    await services.register('EidanSecrets', secrets);
    services.tools.register(secretTool(secrets));
  },
};
