// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { loadRoutes, NotifyImpl, type Notify } from './notify.js';

// Plugins emit notifications topic-first: services.Notify?.emit('job.update', 'job X done').
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    Notify?: Notify;
  }
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'Topology-driven outbound notifications: routes topics (node.startup/job.update/amygdala/…) to channels (slack/telegram) via EIDAN_NOTIFY_ROUTES. Registers the Notify service.',
  },
  async setup(services: MatbotServices) {
    const routes = loadRoutes(process.env['EIDAN_NOTIFY_ROUTES']);
    const tgToken = process.env['EIDAN_TELEGRAM_BOT_TOKEN'] ?? process.env['TELEGRAM_BOT_TOKEN'];
    const slackToken = process.env['EIDAN_SLACK_BOT_TOKEN'];
    const notify = new NotifyImpl({
      routes,
      dryRun: process.env['EIDAN_NOTIFY_DRYRUN'] === '1',
      ...(tgToken !== undefined ? { telegramToken: tgToken } : {}),
      ...(slackToken !== undefined ? { slackToken } : {}),
    });
    await services.register('Notify', notify);
    console.log(`[notify] routes=[${[...routes.keys()].join(',')}]${process.env['EIDAN_NOTIFY_DRYRUN'] === '1' ? ' (dry-run)' : ''}`);
    void notify.emit('node.startup', 'eidan-matbot node started', 'info');
  },
};
