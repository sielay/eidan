// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent tools for the `social-mastodon` plugin — post/search/read on Mastodon (federated).
//
// Per-account, per-host OAuth: the operator connects one or more Mastodon accounts in the Connections
// screen. Mastodon is federated, so each account lives on a HOST (instance domain); there is no
// operator-supplied client — the kit registers an OAuth app with each instance on demand and caches
// it per host. Each account's access token is sealed in the vault; the registry rows live in
// plugin_social_mastodon.accounts. At call time the tools pick the requested account (or the first),
// build a client from BOTH its token and its host, then call the instance's API. Falls back to the
// legacy single MASTODON_INSTANCE + MASTODON_ACCESS_TOKEN secrets when no account is connected.
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import {
  type AccountStore,
  type SealFn,
  AccountResolveError,
  NotConnectedError,
  resolveAccessToken,
} from '@eidandev/connections-kit';
import { MastodonClient } from './client.js';
import { mastodonAdapter } from './adapter.js';
import { secretOpt } from './vault.js';

// Strip HTML tags from Mastodon content/bio to plain text. Applied to a fixpoint so nested/broken
// markup (e.g. `<<b>>`) can't survive a single pass — avoids the incomplete-sanitization footgun.
function stripHtml(input: string): string {
  let out = input;
  let prev = '';
  while (out !== prev) {
    prev = out;
    out = out.replace(/<[^>]*>/g, '');
  }
  return out;
}

const ACCOUNT_PROP = {
  account: {
    type: 'string',
    description: 'Which connected Mastodon account (name or slug). Omit to use the first connected account.',
  },
} as const;

const POST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 500, description: 'Toot text (max 500 characters).' },
    reply_to: { type: 'string', description: 'Optional status ID to reply to.' },
    visibility: {
      type: 'string',
      enum: ['public', 'unlisted', 'private', 'direct'],
      description: 'Visibility level (default: public). public, unlisted, private, or direct.',
    },
    ...ACCOUNT_PROP,
  },
};

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1, description: 'Search text (keywords, hashtags, @handles).' },
    limit: { type: 'integer', minimum: 1, maximum: 40, description: 'Max results (default 20).' },
    ...ACCOUNT_PROP,
  },
};

const PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    account_id: { type: 'string', description: 'Optional account ID to fetch (default: your own).' },
    ...ACCOUNT_PROP,
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
    ...ACCOUNT_PROP,
  },
};

// Resolve a Mastodon client for the selected account: registry first (built from the resolved token
// AND the account's host), then the legacy single MASTODON_INSTANCE + MASTODON_ACCESS_TOKEN secrets.
// Returns an error string when nothing usable resolves.
async function resolveClient(
  ctx: ToolContext,
  store: AccountStore | null,
  seal: SealFn | undefined,
  account: string | undefined,
): Promise<{ client?: MastodonClient; error?: string }> {
  if (store) {
    try {
      const { accessToken, account: acct } = await resolveAccessToken(store, mastodonAdapter, ctx, {
        ...(account ? { accountSelector: account } : {}),
        ...(seal ? { seal } : {}),
      });
      return { client: new MastodonClient(accessToken, acct.host) };
    } catch (exc) {
      if (exc instanceof AccountResolveError) return { error: exc.message };
      if (!(exc instanceof NotConnectedError)) {
        return { error: exc instanceof Error ? exc.message : 'failed to resolve Mastodon account' };
      }
      // NotConnectedError → fall through to the legacy single-secret path.
    }
  }
  const instance = await secretOpt(ctx, 'MASTODON_INSTANCE');
  const token = await secretOpt(ctx, 'MASTODON_ACCESS_TOKEN');
  if (instance && token) return { client: new MastodonClient(token, instance) };
  return {
    error:
      "Mastodon isn't connected — add an account under Connections, or set the legacy MASTODON_INSTANCE and MASTODON_ACCESS_TOKEN vault secrets.",
  };
}

export function makeMastodonTools(store: AccountStore | null, seal?: SealFn): Tool[] {
  const mastodonPostTool: Tool = {
    name: 'mastodon_post',
    description:
      'Post a toot to a connected Mastodon account. Supports public, unlisted, private, and direct visibility. Optionally reply to an existing toot. Use `account` to pick which connected Mastodon account.',
    inputSchema: POST_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { text?: string; reply_to?: string; visibility?: string; account?: string };
        const text = String(args.text ?? '').trim();
        if (!text) {
          yield { type: 'error', message: 'text is required' };
          return;
        }

        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create Mastodon client' };
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
              message: 'Posted to Mastodon',
            },
          };
        }
      },
    },
  };

  const mastodonSearchTool: Tool = {
    name: 'mastodon_search',
    description:
      'Search Mastodon for toots by keyword, hashtag, or @handle. Returns matching toots with author info and engagement metrics. Use `account` to pick which connected Mastodon account.',
    inputSchema: SEARCH_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { query?: string; limit?: number; account?: string };
        const query = String(args.query ?? '').trim();
        if (!query) {
          yield { type: 'error', message: 'query is required' };
          return;
        }

        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create Mastodon client' };
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
                text: stripHtml(status.content),
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
      'Get account profile info (followers, bio, avatar, status count). Optionally fetch another account by ID; defaults to your own. Use `account` to pick which connected Mastodon account.',
    inputSchema: PROFILE_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { account_id?: string; account?: string };

        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create Mastodon client' };
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
              bio: stripHtml(result.account.note),
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
      "Read a Mastodon timeline (home feed, local/instance, or federated). Returns recent toots with author info and engagement metrics. 'home' shows your curated feed, 'local' shows instance toots, 'federated' shows the broader network. Use `account` to pick which connected Mastodon account.",
    inputSchema: TIMELINE_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { limit?: number; timeline_type?: string; account?: string };
        const timelineType = (args.timeline_type || 'home') as 'home' | 'local' | 'federated';

        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create Mastodon client' };
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
                text: stripHtml(status.content),
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
