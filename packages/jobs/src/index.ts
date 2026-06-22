// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { Db } from './db.js';
import { JobHandlerRegistry, makeTurnHandler, startJobWorker, type JobHandlers } from './job-runner.js';
import { buildJobTools } from './tools.js';

// Advertise the handler registry so bundles register kind-specific workers:
// services.JobHandlers?.register('code', sageCodeHandler).
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    JobHandlers?: JobHandlers;
  }
}

let stop: (() => Promise<void>) | undefined;
let db: Db | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'eidan delegation work-queue: claims eidan.jobs by capability kind and runs them (default: as an agent turn). Bundles register kind handlers via services.JobHandlers.',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) throw new Error('EIDAN_DATABASE_URL (or DATABASE_URL) must be set for @eidandev/jobs');
    const kinds = (process.env['EIDAN_JOB_KINDS'] ?? 'chat').split(',').map((s) => s.trim()).filter(Boolean);
    const provider = process.env['EIDAN_JOB_PROVIDER'] ?? 'claude';
    const nodeId = process.env['EIDAN_NODE_ID'] ?? `mb-${crypto.randomUUID().slice(0, 8)}`;

    db = new Db(url);
    const registry = new JobHandlerRegistry();
    registry.register('chat', makeTurnHandler(provider)); // default kind
    await services.register('JobHandlers', registry);
    for (const tool of buildJobTools(db)) services.tools.register(tool);
    stop = startJobWorker(services, db, { kinds, nodeId, provider, registry });
    console.log(`[jobs] worker started: node=${nodeId} kinds=[${kinds.join(',')}] provider=${provider}`);
  },
  async teardown() {
    if (stop) await stop();
    if (db) await db.close();
  },
};
