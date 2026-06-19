// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { loadRoutes, NotifyImpl, type Notify } from './notify.js';
import { notifyTool } from './tools.js';

// Plugins emit notifications topic-first: services.Notify?.emit('job.update', 'job X done').
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    Notify?: Notify;
  }
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'Outbound messaging: a free-form send_message tool (agent posts to any Slack channel / Telegram chat directly) + topology-driven system-event routing (node.startup/job.update/amygdala/… → a channel via EIDAN_NOTIFY_ROUTES). Registers the Notify service.',
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
    // Expose the free-form send tool. Capability = which channels we hold a token for; the agent
    // chooses the destination at call time (no operator-declared route needed). See tools.ts.
    services.tools.register(notifyTool(notify, { slack: slackToken !== undefined, telegram: tgToken !== undefined }));
    console.log(`[notify] send_message tool registered (slack=${slackToken !== undefined}, telegram=${tgToken !== undefined}); system-event routes=[${[...routes.keys()].join(',')}]${process.env['EIDAN_NOTIFY_DRYRUN'] === '1' ? ' (dry-run)' : ''}`);
    void notify.emit('node.startup', 'eidan-matbot node started', 'info');
  },
};
