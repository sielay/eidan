// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import { MastodonClient } from './client.js';

const POST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: 'Toot text (max 500 characters).',
    },
    reply_to: {
      type: 'string',
      description: 'Optional status ID to reply to.',
    },
    visibility: {
      type: 'string',
      enum: ['public', 'unlisted', 'private', 'direct'],
      description: 'Visibility level (default: public). public, unlisted, private, or direct.',
    },
  },
};

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1, description: 'Search text (keywords, hashtags, @handles).' },
    limit: { type: 'integer', minimum: 1, maximum: 40, description: 'Max results (default 20).' },
  },
};

const PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    account_id: { type: 'string', description: 'Optional account ID to fetch (default: your own).' },
  },
};

const TIMELINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 40, description: 'Max toots (default 20).' },
    timeline_type: {
      type: 'string',
      enum: ['home', 'local', 'federated'],
      description: 'Timeline type: home (your feed), local (instance), or federated (all). Default: home.',
    },
  },
};

export function makeMastodonTools(): Tool[] {
  const mastodonPostTool: Tool = {
    name: 'mastodon_post',
    description:
      'Post a toot to your Mastodon account. Supports public, unlisted, private, and direct visibility. Optionally reply to an existing toot. Requires MASTODON_INSTANCE and MASTODON_ACCESS_TOKEN vault secrets.',
    inputSchema: POST_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { text?: string; reply_to?: string; visibility?: string };
        const text = String(args.text ?? '').trim();

        if (!text) {
          yield { type: 'error', message: 'text is required' };
          return;
        }

        const client = await MastodonClient.create(ctx);
        if (!client) {
          yield {
            type: 'error',
            message:
              "Mastodon isn't connected — set MASTODON_INSTANCE and MASTODON_ACCESS_TOKEN in vault/env (Settings → Connections)",
          };
          return;
        }

        const visibility = args.visibility as 'public' | 'unlisted' | 'private' | 'direct' | undefined;
        const options: { replyTo?: string; visibility?: 'public' | 'unlisted' | 'private' | 'direct' } = {};
        if (args.reply_to) options.replyTo = args.reply_to;
        if (visibility) options.visibility = visibility;
        const result = await client.post(text, options);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              id: result.id,
              url: result.url,
              text,
              visibility: visibility || 'public',
              message: `Posted to Mastodon`,
            },
          };
        }
      },
    },
  };

  const mastodonSearchTool: Tool = {
    name: 'mastodon_search',
    description:
      'Search Mastodon for toots by keyword, hashtag, or @handle. Returns matching toots with author info and engagement metrics.',
    inputSchema: SEARCH_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { query?: string; limit?: number };
        const query = String(args.query ?? '').trim();

        if (!query) {
          yield { type: 'error', message: 'query is required' };
          return;
        }

        const client = await MastodonClient.create(ctx);
        if (!client) {
          yield {
            type: 'error',
            message:
              "Mastodon isn't connected — set MASTODON_INSTANCE and MASTODON_ACCESS_TOKEN in vault/env (Settings → Connections)",
          };
          return;
        }

        const result = await client.search(query, Number(args.limit) || 20);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          const statuses = result.statuses || [];
          yield {
            type: 'result',
            value: {
              query,
              toots: statuses.map((status) => ({
                id: status.id,
                author: `${status.account.acct} (${status.account.display_name || status.account.username})`,
                text: status.content.replace(/<[^>]*>/g, ''),
                favorites: status.favourites_count,
                replies: status.replies_count,
                reblogs: status.reblogs_count,
                created: status.created_at,
                url: status.url,
              })),
              count: statuses.length,
            },
          };
        }
      },
    },
  };

  const mastodonGetProfileTool: Tool = {
    name: 'mastodon_get_profile',
    description:
      'Get account profile info (followers, bio, avatar, status count). Optionally fetch another account by ID; defaults to your own.',
    inputSchema: PROFILE_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { account_id?: string };

        const client = await MastodonClient.create(ctx);
        if (!client) {
          yield {
            type: 'error',
            message:
              "Mastodon isn't connected — set MASTODON_INSTANCE and MASTODON_ACCESS_TOKEN in vault/env (Settings → Connections)",
          };
          return;
        }

        const result = await client.getProfile(args.account_id);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else if (result.account) {
          yield {
            type: 'result',
            value: {
              username: result.account.acct,
              display_name: result.account.display_name || result.account.username,
              bio: result.account.note.replace(/<[^>]*>/g, ''),
              followers: result.account.followers_count,
              following: result.account.following_count,
              statuses: result.account.statuses_count,
              avatar: result.account.avatar,
              url: result.account.url,
              created: result.account.created_at,
            },
          };
        }
      },
    },
  };

  const mastodonListTimelineTool: Tool = {
    name: 'mastodon_list_timeline',
    description:
      "Read a Mastodon timeline (home feed, local/instance, or federated). Returns recent toots with author info and engagement metrics. 'home' shows your curated feed, 'local' shows instance toots, 'federated' shows the broader network.",
    inputSchema: TIMELINE_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { limit?: number; timeline_type?: string };
        const timelineType = (args.timeline_type || 'home') as 'home' | 'local' | 'federated';

        const client = await MastodonClient.create(ctx);
        if (!client) {
          yield {
            type: 'error',
            message:
              "Mastodon isn't connected — set MASTODON_INSTANCE and MASTODON_ACCESS_TOKEN in vault/env (Settings → Connections)",
          };
          return;
        }

        const result = await client.getTimeline(timelineType, Number(args.limit) || 20);

        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          const statuses = result.statuses || [];
          yield {
            type: 'result',
            value: {
              timeline_type: timelineType,
              toots: statuses.map((status) => ({
                id: status.id,
                author: `${status.account.acct} (${status.account.display_name || status.account.username})`,
                text: status.content.replace(/<[^>]*>/g, ''),
                favorites: status.favourites_count,
                replies: status.replies_count,
                reblogs: status.reblogs_count,
                created: status.created_at,
                url: status.url,
              })),
              count: statuses.length,
            },
          };
        }
      },
    },
  };

  return [mastodonPostTool, mastodonSearchTool, mastodonGetProfileTool, mastodonListTimelineTool];
}
