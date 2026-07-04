// SPDX-License-Identifier: AGPL-3.0-or-later
// Journal — drop a text/voice note; it is categorised, logged structurally (plugin_journal.*) under
// an editable direction prompt, and routed. Voice needs nothing here: @eidandev/transcribe turns a
// Telegram/chat voice note into text before the turn, so a note arrives as a normal user message.
//
// A light `screen` nudge tells the assistant to file build-log / progress updates via journal_capture
// (following the direction prompt). It fires at most once per human turn and is one short sentence —
// disable with EIDAN_JOURNAL_NUDGE=0 if you'd rather journal only on an explicit "journal this".
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

import { JournalDb } from './db.js';
import { buildJournalTools } from './tools.js';

const NUDGE =
  'If the operator\'s message is a build-log / progress / "I did / found / want" style update, ' +
  'record each distinct item with journal_capture (call journal_direction first if unsure how to ' +
  'categorise or route). Otherwise ignore this note.';

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Journal: capture text/voice notes, categorise + log them structurally (plugin_journal.*) under ' +
      'an editable direction prompt, and route — bug/task entries open a sage code job; scheduled ' +
      'planning agents read the journal to draft blog/journey content.',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) throw new Error('EIDAN_DATABASE_URL (or DATABASE_URL) must be set for @eidandev/journal');
    const db = new JournalDb(url);
    await db.ensureSchema();
    for (const tool of buildJournalTools(db)) services.tools.register(tool);

    if (process.env['EIDAN_JOURNAL_NUDGE'] !== '0') {
      services.hooks.register({
        on: 'screen',
        pluginName: 'journal',
        handler(ctx) {
          // Only nudge on a human turn — skip agent/robo/tool re-entries to keep the token cost to
          // one sentence per operator message, not per provider call.
          const msgs = ctx.session.messages;
          const last = msgs[msgs.length - 1] as { role?: string } | undefined;
          if (last?.role !== 'user') return;
          return { ephemeral: [{ type: 'text', text: NUDGE }] };
        },
      });
    }

    console.log('[journal] registered journal tools' + (process.env['EIDAN_JOURNAL_NUDGE'] === '0' ? '' : ' + capture nudge'));
  },
};
