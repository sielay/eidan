// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { Db } from './db.js';
import { RoutinesStore } from './store.js';
import { buildRoutineTools } from './tools.js';
import { startRoutinesLoop } from './loop.js';

// Advertise the routines store so other plugins (e.g. a future amigdala/observability surface) can
// schedule or read routines with type safety: services.Routines?.list().
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    Routines?: RoutinesStore;
  }
}

let db: Db | undefined;
let stop: (() => Promise<void>) | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'eidan recurring routines: schedule a prompt to run on a cadence ("every morning at 08:00, brief me"). ' +
      'Registers routine_create/list/update/delete tools and a poll loop that runs each due routine as an ' +
      'agent turn (owner timezone) and delivers the result via @eidandev/notify (topic "routine").',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) throw new Error('EIDAN_DATABASE_URL (or DATABASE_URL) must be set for @eidandev/routines');
    db = new Db(url);
    const store = new RoutinesStore(db);
    await services.register('Routines', store);
    for (const tool of buildRoutineTools(store)) services.tools.register(tool);

    const provider =
      process.env['EIDAN_ROUTINE_PROVIDER'] ??
      process.env['EIDAN_AGUI_PROVIDER'] ??
      process.env['EIDAN_JOB_PROVIDER'] ??
      'claude';
    const pollMs = Number(process.env['EIDAN_ROUTINE_POLL_MS'] ?? '60000');
    const graceMinutes = Number(process.env['EIDAN_ROUTINE_GRACE_MIN'] ?? '30');
    stop = startRoutinesLoop(services, store, { provider, pollMs, graceMinutes });
    console.log(`[routines] loop started (provider=${provider}, poll=${pollMs}ms, grace=${graceMinutes}m)`);
  },
  async teardown() {
    if (stop) await stop();
    if (db) await db.close();
  },
};
