// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent tools for the `social-linkedin` plugin — post/search/profile/feed on LinkedIn.
//
// Per-account OAuth: the operator connects one or more LinkedIn accounts in the Connections screen.
// Each account's OAuth client (sealed under client_vault_key) + access token (token key) live in the
// vault; the registry rows live in plugin_social_linkedin.accounts. At call time the tools pick the
// requested account (or the first), resolve an access token via the connections kit, then call the
// LinkedIn API. Falls back to the legacy single LINKEDIN_ACCESS_TOKEN secret when no account is
// connected, so older setups keep working.
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import {
  type AccountStore,
  type SealFn,
  AccountResolveError,
  NotConnectedError,
  resolveAccessToken,
} from '@eidandev/connections-kit';
import { LinkedInClient } from './client.js';
import { linkedinAdapter } from './adapter.js';
import { secretOpt } from './vault.js';

const ACCOUNT_PROP = {
  account: {
    type: 'string',
    description: 'Which connected LinkedIn account (name or slug). Omit to use the first connected account.',
  },
} as const;

const POST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: {
      type: 'string',
      minLength: 1,
      maxLength: 3000,
      description: 'Post text (max 3000 characters).',
    },
    image_url: {
      type: 'string',
      format: 'uri',
      description: 'Optional image URL to attach to the post. Must be HTTPS. Private/internal IPs are rejected for security.',
    },
    ...ACCOUNT_PROP,
  },
};

const GET_PROFILE_SCHEMA = { type: 'object', additionalProperties: false, properties: { ...ACCOUNT_PROP } };

const LIST_FEED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Max posts (default 20).',
    },
    ...ACCOUNT_PROP,
  },
};

// Resolve a LinkedIn client for the selected account: registry first, then the legacy single
// LINKEDIN_ACCESS_TOKEN secret. Returns an error string when nothing usable resolves.
async function resolveClient(
  ctx: ToolContext,
  store: AccountStore | null,
  seal: SealFn | undefined,
  account: string | undefined,
): Promise<{ client?: LinkedInClient; error?: string }> {
  if (store) {
    try {
      const { accessToken, account: acc } = await resolveAccessToken(store, linkedinAdapter, ctx, {
        ...(account ? { accountSelector: account } : {}),
        ...(seal ? { seal } : {}),
      });
      // Post as the org URN for a Page/organization connection, else the member's person URN. The
      // org connection's external_id is already a `urn:li:organization:…`; a member's is the person id.
      const isOrg = acc.metadata['type'] === 'organization';
      const author = isOrg
        ? acc.external_id
        : acc.external_id
          ? `urn:li:person:${acc.external_id}`
          : undefined;
      return {
        client: new LinkedInClient(accessToken, {
          ...(author ? { author } : {}),
          type: isOrg ? 'organization' : 'member',
          handle: acc.external_handle,
        }),
      };
    } catch (exc) {
      if (exc instanceof AccountResolveError) return { error: exc.message };
      if (!(exc instanceof NotConnectedError)) {
        return { error: exc instanceof Error ? exc.message : 'failed to resolve LinkedIn account' };
      }
      // NotConnectedError → fall through to the legacy single-secret path.
    }
  }
  const token = await secretOpt(ctx, 'LINKEDIN_ACCESS_TOKEN');
  if (token) return { client: new LinkedInClient(token) };
  return {
    error:
      "LinkedIn isn't connected — add an account under Connections, or set the legacy LINKEDIN_ACCESS_TOKEN vault secret.",
  };
}

export function makeLinkedinTools(store: AccountStore | null, seal?: SealFn): Tool[] {
  const linkedinPostTool: Tool = {
    name: 'linkedin_post',
    description:
      "Post a message to a connected LinkedIn account's feed (up to 3000 chars; optional image_url). Use `account` to pick which connected LinkedIn account.",
    inputSchema: POST_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { text?: string; image_url?: string; account?: string };
        const text = String(args.text ?? '').trim();
        if (!text) {
          yield { type: 'error', message: 'text is required' };
          return;
        }
        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create LinkedIn client' };
          return;
        }
        const result = await client.post(text, args.image_url);
        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              id: result.id,
              text,
              message: 'Posted to LinkedIn',
            },
          };
        }
      },
    },
  };

  const linkedinGetProfileTool: Tool = {
    name: 'linkedin_get_profile',
    description:
      "Get a connected LinkedIn account's profile (name, headline, profile picture). Use `account` to pick which connected LinkedIn account.",
    inputSchema: GET_PROFILE_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { account?: string };
        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create LinkedIn client' };
          return;
        }
        const result = await client.getProfile();
        if (result.error) {
          yield { type: 'error', message: result.error };
        } else if (result.profile) {
          yield {
            type: 'result',
            value: {
              id: result.profile.id,
              name: result.profile.name,
              kind: result.profile.kind,
              ...(result.profile.headline ? { headline: result.profile.headline } : {}),
              ...(result.profile.email ? { email: result.profile.email } : {}),
              ...(result.profile.picture ? { picture: result.profile.picture } : {}),
            },
          };
        } else {
          yield { type: 'error', message: 'Failed to retrieve profile' };
        }
      },
    },
  };

  const linkedinListFeedTool: Tool = {
    name: 'linkedin_list_feed',
    description:
      "List recent posts published BY a connected LinkedIn account (the member's own posts, or the organization's Page posts). NOTE: LinkedIn has no API to read other members' feeds or to search posts — only this account's own posts. IMPORTANT: Engagement metrics (likes, comments) are currently unavailable due to API permission restrictions. The Community Management API requires 'r_member_social_feed' permission (restricted) to fetch reactions. Operator has filed for standard tier access — once approved, engagement data can be enabled. Use `account` to pick which connected LinkedIn account.",
    inputSchema: LIST_FEED_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { limit?: number; account?: string };
        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create LinkedIn client' };
          return;
        }
        const result = await client.listFeed(Number(args.limit) || 20);
        if (result.error) {
          yield { type: 'error', message: result.error };
        } else {
          yield {
            type: 'result',
            value: {
              posts: (result.posts ?? []).map((post) => ({
                id: post.id,
                text: post.text,
                likes: post.likes,
                comments: post.comments,
                engagement_data_available: post.engagement_data_available,
              })),
              count: result.posts?.length ?? 0,
              // NOTE: engagement_data_available is currently hardcoded to false in client.ts,
              // so this .every() check will always be false and notice will always be defined.
              // Once r_member_social_feed permission is granted and engagement data can be
              // fetched, this notice will only appear if some (but not all) posts have data.
              notice: !result.posts?.every((p) => p.engagement_data_available)
                ? 'Engagement metrics (likes, comments) are currently unavailable. Requires LinkedIn Community Management API standard tier + r_member_social_feed permission.'
                : undefined,
            },
          };
        }
      },
    },
  };

  return [linkedinPostTool, linkedinGetProfileTool, linkedinListFeedTool];
}
