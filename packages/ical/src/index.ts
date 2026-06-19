// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { Db } from './db.js';
import { makeCalendarTools } from './tools.js';

// eidan `ical` plugin: read-through CalDAV/.ics calendars as agent tools, over the operator's
// own named calendars. Each calendar (name + context prompt + .ics URL) is managed in the Calendars
// screen (the plugin's frontend manifest); the URL is sealed in the vault, the registry lives in
// plugin_ical. Nothing is synced or stored beyond that registry — feeds are read live per call.
let db: Db | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      "Calendar (iCal feeds): read-through .ics reading over the operator's named calendars " +
      '(managed in the Calendars screen; feed URLs sealed in the vault, per-user). Registers ' +
      'calendar_upcoming + calendar_search, with each event tagged by its calendar name + context.',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) {
      throw new Error('EIDAN_DATABASE_URL (or DATABASE_URL) must be set for @eidandev/ical (it owns the plugin_ical calendar registry)');
    }
    db = new Db(url);
    await db.ensureSchema();
    for (const tool of makeCalendarTools(db)) services.tools.register(tool);

    // Ambient context (matbot systemContext): every turn, prepend the operator's timezone (+ today)
    // and calendar routine to the system prompt — so the agent reasons in their zone and knows their
    // day shape, not just when it calls a calendar tool. Stable / daily ⇒ prompt-cache friendly.
    services.systemContext.register(async () => {
      if (!db) return null;
      const { routine, timezone } = await db.getSettings();
      const parts: string[] = [];
      if (timezone) {
        let today = '';
        try {
          today = new Date().toLocaleDateString('en-GB', {
            timeZone: timezone,
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          });
        } catch {
          today = '';
        }
        parts.push(
          `The operator's timezone is ${timezone}${today ? ` (today is ${today})` : ''}. ` +
            'Present all times in this timezone. Calendar tool results are ALREADY given as local ' +
            'wall-clock time in this zone (with a zone label like BST/GMT) — state them as-is, never ' +
            're-convert them.',
        );
      }
      if (routine) {
        parts.push(`The operator's general routine (use it to weigh timing + priority): ${routine}`);
      }
      return parts.length > 0 ? parts.join('\n') : null;
    }, 'ical');
  },
  async teardown() {
    if (db) await db.close();
  },
};
