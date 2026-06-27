// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import { LinkedInClient } from './client.js';
import { secretRequired, secretOpt } from './vault.js';

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
  },
};

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      description: 'Search text (keywords, company names, topics).',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Max results (default 20).',
    },
  },
};

const GET_PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {},
};

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
  },
};

export function makeLinkedInTools(): Tool[] {
  const linkedinPostTool: Tool = {
    name: 'linkedin_post',
    description:
      'Post a message to the operator\'s LinkedIn feed. Supports text and optional image. Requires LINKEDIN_ACCESS_TOKEN vault secret.',
    inputSchema: POST_SCHEMA,
    executor: {
      async *execute(input: any, ctx: ToolContext) {
        const args = (input ?? {}) as { text?: string; image_url?: string };
        const text = String(args.text ?? '').trim();

        if (!text) {
          yield { type: 'error', message: 'text is required' };
          return;
        }

        // Note: image_url is validated in client (HTTPS, no private IPs)
        try {
          const token = await secretRequired(ctx, 'LINKEDIN_ACCESS_TOKEN');
          const customDomains = await secretOpt(ctx, 'LINKEDIN_ALLOWED_IMAGE_DOMAINS');
          const client = new LinkedInClient(ctx, token, customDomains ?? undefined);
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
        } catch (err) {
          yield {
            type: 'error',
            message: `LinkedIn isn't connected — LINKEDIN_ACCESS_TOKEN is missing in vault/env (Settings → Connections)`,
          };
        }
      },
    },
  };

  const linkedinSearchTool: Tool = {
    name: 'linkedin_search',
    description:
      'Search LinkedIn for posts by keyword, company name, or topic. Returns matching posts with engagement metrics.',
    inputSchema: SEARCH_SCHEMA,
    executor: {
      async *execute(input: any, ctx: ToolContext) {
        const args = (input ?? {}) as { query?: string; limit?: number };
        const query = String(args.query ?? '').trim();

        if (!query) {
          yield { type: 'error', message: 'query is required' };
          return;
        }

        // Note: inputSchema validates limit as integer 1-100; use nullish coalescing since schema ensures valid input
        try {
          const token = await secretRequired(ctx, 'LINKEDIN_ACCESS_TOKEN');
          const customDomains = await secretOpt(ctx, 'LINKEDIN_ALLOWED_IMAGE_DOMAINS');
          const client = new LinkedInClient(ctx, token, customDomains ?? undefined);
          const result = await client.search(query, args.limit ?? 20);

          if (result.error) {
            yield { type: 'error', message: result.error };
          } else {
            yield {
              type: 'result',
              value: {
                query,
                posts: (result.posts ?? []).map((post) => ({
                  id: post.id,
                  text: post.text,
                  author: post.author,
                  likes: post.likes,
                  comments: post.comments,
                })),
                count: result.posts?.length ?? 0,
              },
            };
          }
        } catch (err) {
          yield {
            type: 'error',
            message: `LinkedIn isn't connected — LINKEDIN_ACCESS_TOKEN is missing in vault/env (Settings → Connections)`,
          };
        }
      },
    },
  };

  const linkedinGetProfileTool: Tool = {
    name: 'linkedin_get_profile',
    description:
      'Get the authenticated user\'s LinkedIn profile information (name, headline, profile picture). Requires LINKEDIN_ACCESS_TOKEN vault secret.',
    inputSchema: GET_PROFILE_SCHEMA,
    executor: {
      async *execute(input: any, ctx: ToolContext) {
        try {
          const token = await secretRequired(ctx, 'LINKEDIN_ACCESS_TOKEN');
          const customDomains = await secretOpt(ctx, 'LINKEDIN_ALLOWED_IMAGE_DOMAINS');
          const client = new LinkedInClient(ctx, token, customDomains ?? undefined);
          const result = await client.getProfile();

          if (result.error) {
            yield { type: 'error', message: result.error };
          } else if (result.profile) {
            // Extract profilePicture from deeply nested LinkedIn API structure:
            // profile.profilePicture.elements[0].identifiers[0].identifier
            // This path is fragile; it defaults to empty string if any level is undefined.
            // If a profile picture is expected but not found, check that the LinkedIn API
            // request includes the ?projectionFields=profilePicture query parameter.
            const profilePicture =
              result.profile.profilePicture?.elements?.[0]?.identifiers?.[0]?.identifier || '';
            yield {
              type: 'result',
              value: {
                id: result.profile.id,
                firstName: result.profile.localizedFirstName || '',
                lastName: result.profile.localizedLastName || '',
                headline: result.profile.localizedHeadline || '',
                profilePicture,
              },
            };
          } else {
            yield { type: 'error', message: 'Failed to retrieve profile' };
          }
        } catch (err) {
          yield {
            type: 'error',
            message: `LinkedIn isn't connected — LINKEDIN_ACCESS_TOKEN is missing in vault/env (Settings → Connections)`,
          };
        }
      },
    },
  };

  const linkedinListFeedTool: Tool = {
    name: 'linkedin_list_feed',
    description:
      'Get the operator\'s LinkedIn feed. Returns recent posts from the user\'s network with engagement metrics.',
    inputSchema: LIST_FEED_SCHEMA,
    executor: {
      async *execute(input: any, ctx: ToolContext) {
        const args = (input ?? {}) as { limit?: number };

        // Note: inputSchema validates limit as integer 1-100 if provided; use nullish coalescing since schema ensures valid input
        try {
          const token = await secretRequired(ctx, 'LINKEDIN_ACCESS_TOKEN');
          const customDomains = await secretOpt(ctx, 'LINKEDIN_ALLOWED_IMAGE_DOMAINS');
          const client = new LinkedInClient(ctx, token, customDomains ?? undefined);
          const result = await client.listFeed(args.limit ?? 20);

          if (result.error) {
            yield { type: 'error', message: result.error };
          } else {
            yield {
              type: 'result',
              value: {
                posts: (result.posts ?? []).map((post) => ({
                  id: post.id,
                  text: post.text,
                  author: post.author,
                  likes: post.likes,
                  comments: post.comments,
                })),
                count: result.posts?.length ?? 0,
              },
            };
          }
        } catch (err) {
          yield {
            type: 'error',
            message: `LinkedIn isn't connected — LINKEDIN_ACCESS_TOKEN is missing in vault/env (Settings → Connections)`,
          };
        }
      },
    },
  };

  return [linkedinPostTool, linkedinSearchTool, linkedinGetProfileTool, linkedinListFeedTool];
}
