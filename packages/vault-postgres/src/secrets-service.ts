// SPDX-License-Identifier: AGPL-3.0-or-later
import { Db } from './db.js';
import { PostgresVault } from './vault.js';

// A field a plugin needs from the user. `secret: true` => masked, UI-only entry (never echoed,
// never sent to the LLM). The settings UI renders one section per declaring plugin.
export interface SecretField {
  name: string;            // exact vault key, e.g. 'EIDAN_IMAP_PASSWORD'
  label: string;           // human label, e.g. 'IMAP password'
  secret?: boolean;        // true => masked field; false => plain config (e.g. a public .ics URL)
  required?: boolean;
  help?: string;           // hint / where to find the value
}

export interface SecretSection {
  plugin: string;          // declaring plugin, e.g. 'imap'
  title: string;           // section title, e.g. 'Email (IMAP/SMTP)'
  fields: SecretField[];
}

export interface SecretMeta {
  name: string;
  scope: 'you' | 'instance';
  updatedAt: Date;
}

// The eidan-specific secrets surface (richer than matbot's Vault): the catalog of what plugins
// need, metadata on what's set, and the secure write/delete the UI calls. Writes encrypt at rest
// and are user-scoped via the ambient Principal. Consumed by @eidandev/secrets-api (HTTP) and any
// other eidan plugin; values are NEVER returned.
export interface EidanSecrets {
  declareSection(section: SecretSection): void;
  catalog(): SecretSection[];
  setSecret(name: string, value: string): Promise<void>;
  deleteSecret(name: string): Promise<boolean>;
  listMetadata(): Promise<SecretMeta[]>;
}

export class EidanSecretsImpl implements EidanSecrets {
  private readonly db: Db;
  private readonly vault: PostgresVault;
  private readonly sections = new Map<string, SecretSection>();

  constructor(db: Db, vault: PostgresVault) {
    this.db = db;
    this.vault = vault;
  }

  declareSection(section: SecretSection): void {
    this.sections.set(section.plugin, section);
  }

  catalog(): SecretSection[] {
    return [...this.sections.values()];
  }

  async setSecret(name: string, value: string): Promise<void> {
    await this.vault.writeSecret(name, value);
  }

  async deleteSecret(name: string): Promise<boolean> {
    return this.vault.deleteSecret(name);
  }

  async listMetadata(): Promise<SecretMeta[]> {
    const rows = await this.db.list();
    return rows.map(r => ({
      name: r.scope === 'core' ? r.key : `${r.scope}.${r.key}`,
      scope: r.user_id ? ('you' as const) : ('instance' as const),
      updatedAt: r.updated_at,
    }));
  }
}
