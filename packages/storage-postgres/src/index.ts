// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { EidanStorageBackend } from './backend.js';

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'eidan relational Postgres storage backend (Store<Session> over eidan.*, keen append-only, ambient-principal RLS).',
  },
  storageBackend: {
    open: (dotData: string) => EidanStorageBackend.open(dotData),
  },
  async setup(services: MatbotServices) {
    // Startup pre-scan already opened the backend — nothing to do.
    if (services.StorageBackend instanceof EidanStorageBackend) return;
    // Hot-loaded at runtime: activate now (re-wires all live Store proxies).
    await services.register('StorageBackend', await EidanStorageBackend.open(''));
  },
};
