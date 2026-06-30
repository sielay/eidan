// SPDX-License-Identifier: AGPL-3.0-or-later
// eidan `reddit-research` plugin: search Reddit for market trends and pain points across ventures.
// Agents can call search_reddit, get_trends, and generate_report to extract insights from Reddit.
// Credentials: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET (snoowrap app-only OAuth)
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { RedditDb } from './db.js';
import { makeRedditTools } from './tools.js';

interface SecretField {
  name: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  help?: string;
}
interface SecretSection {
  plugin: string;
  title: string;
  fields: SecretField[];
}

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    EidanSecrets?: {
      declareSection(section: SecretSection): void;
      setSecret(name: string, value: string): Promise<void>;
    };
  }
}

let db: RedditDb | undefined;

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Reddit research tool: search subreddits for market trends and pain points, cache results, and generate reports (search_reddit, get_trends, generate_report). Requires snoowrap OAuth credentials.',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) {
      return;
    }

    db = new RedditDb(url);
    for (const tool of makeRedditTools(db)) {
      services.tools.register(tool);
    }

    services.EidanSecrets?.declareSection({
      plugin: 'reddit-research',
      title: 'Reddit Research API',
      fields: [
        {
          name: 'REDDIT_CLIENT_ID',
          label: 'Reddit App Client ID',
          secret: true,
          required: true,
          help: 'OAuth app client ID from reddit.com/prefs/apps (create an app)',
        },
        {
          name: 'REDDIT_CLIENT_SECRET',
          label: 'Reddit App Client Secret',
          secret: true,
          required: true,
          help: 'OAuth app client secret (keep secret)',
        },
        {
          name: 'REDDIT_REFRESH_TOKEN',
          label: 'Reddit Refresh Token (optional)',
          secret: true,
          help: 'For long-lived sessions; leave empty for read-only public access',
        },
      ],
    });
  },
  async teardown() {
    if (db) await db.close();
  },
};
