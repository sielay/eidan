// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Store, FileStore, StorageBackend } from '@matatbread/matbot-plugin-api';
import { Db } from './db.js';
import { PgSessionStore, PgKvStore } from './session-store.js';
import { PgFileStore } from './file-store.js';

export class EidanStorageBackend implements StorageBackend {
  readonly fileStore: FileStore;
  private readonly stores = new Map<string, unknown>();
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
    this.fileStore = new PgFileStore(db);
  }

  createStore<T extends { id: string; version: string }>(namespace: string): Store<T> {
    let s = this.stores.get(namespace);
    if (!s) {
      s = namespace === 'sessions' ? new PgSessionStore(this.db) : new PgKvStore<T>(this.db, namespace);
      this.stores.set(namespace, s);
    }
    return s as Store<T>;
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  // The eidan DB connection string is static infra config → env (eidan secrets doctrine:
  // static app config lives in env; only per-user creds go through the vault). This is a
  // node-only plugin (matbotRuntime: ["node"]), so reading env here is allowed.
  static open(_dotData: string): Promise<EidanStorageBackend> {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) {
      return Promise.reject(new Error('EIDAN_DATABASE_URL (or DATABASE_URL) must be set for @eidan/storage-postgres'));
    }
    return Promise.resolve(new EidanStorageBackend(new Db(url)));
  }
}
