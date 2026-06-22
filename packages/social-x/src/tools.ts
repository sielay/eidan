// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool } from '@matatbread/matbot-plugin-api';
import { createXClient } from './client.js';

const POST_TWEET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: {
    text: {
      type: 'string',
      minLength: 1,
      maxLength: 280,
      description: 'Tweet text (max 280 characters).',
    },
    reply_to: {
      type: 'string',
      description: 'Optional tweet ID to reply to.',
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
      description: 'Search query (keywords, #hashtags, from:@handle).',
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

const LIST_TIMELINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Max tweets (default 20).',
    },
  },
};

export function makeXTools(): Tool[] {
  const postTweetTool: Tool = {
    name: 'x_post_tweet',
    description:
      'Post a tweet to the operator\'s X account. Supports text up to 280 characters. Optionally reply to an existing tweet. Requires X_ACCESS_TOKEN vault secret.',
    inputSchema: POST_TWEET_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { text?: string; reply_to?: string };
        const text = String(args.text ?? '').trim();

        if (!text) {
          yield { type: 'error', message: 'text is required' };
          return;
        }

        const result = await createXClient(ctx);
        if (!result.client) {
          yield { type: 'error', message: result.error || 'Failed to create X client' };
          return;
        }

        const postResult = await result.client.postTweet(text, args.reply_to);

        if (postResult.error) {
          yield { type: 'error', message: postResult.error };
        } else {
          yield {
            type: 'result',
            value: {
              tweet_id: postResult.tweetId,
              text: postResult.text,
              url: `https://twitter.com/i/web/status/${postResult.tweetId}`,
              message: 'Posted to X',
            },
          };
        }
      },
    },
  };

  const searchTool: Tool = {
    name: 'x_search',
    description:
      'Search X (Twitter) for tweets by keyword, hashtag, or @handle. Returns matching tweets with author and engagement metrics. Requires X_ACCESS_TOKEN vault secret.',
    inputSchema: SEARCH_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { query?: string; limit?: number };
        const query = String(args.query ?? '').trim();

        if (!query) {
          yield { type: 'error', message: 'query is required' };
          return;
        }

        const result = await createXClient(ctx);
        if (!result.client) {
          yield { type: 'error', message: result.error || 'Failed to create X client' };
          return;
        }

        const searchResult = await result.client.searchTweets(query, Number(args.limit) || 20);

        if (searchResult.error) {
          yield { type: 'error', message: searchResult.error };
        } else {
          yield {
            type: 'result',
            value: {
              query,
              count: searchResult.tweets.length,
              tweets: searchResult.tweets.map((tweet) => ({
                id: tweet.id,
                text: tweet.text,
                author_id: tweet.author_id,
                created_at: tweet.created_at,
                likes: tweet.public_metrics?.like_count ?? 0,
                replies: tweet.public_metrics?.reply_count ?? 0,
                retweets: tweet.public_metrics?.retweet_count ?? 0,
                url: `https://twitter.com/i/web/status/${tweet.id}`,
              })),
            },
          };
        }
      },
    },
  };

  const getProfileTool: Tool = {
    name: 'x_get_profile',
    description:
      'Get the authenticated user\'s X (Twitter) profile information including follower count, bio, and verification status. Requires X_ACCESS_TOKEN vault secret.',
    inputSchema: GET_PROFILE_SCHEMA,
    executor: {
      async *execute(_input, ctx) {
        const result = await createXClient(ctx);
        if (!result.client) {
          yield { type: 'error', message: result.error || 'Failed to create X client' };
          return;
        }

        const profileResult = await result.client.getMe();

        if (profileResult.error) {
          yield { type: 'error', message: profileResult.error };
        } else if (!profileResult.profile) {
          yield { type: 'error', message: 'Profile not found' };
        } else {
          yield {
            type: 'result',
            value: {
              id: profileResult.profile.id,
              name: profileResult.profile.name,
              username: profileResult.profile.username,
              description: profileResult.profile.description,
              followers: profileResult.profile.followers_count ?? 0,
              following: profileResult.profile.following_count ?? 0,
              tweets: profileResult.profile.tweet_count ?? 0,
              verified: profileResult.profile.verified ?? false,
              created_at: profileResult.profile.created_at,
              url: `https://twitter.com/${profileResult.profile.username}`,
            },
          };
        }
      },
    },
  };

  const listTimelineTool: Tool = {
    name: 'x_list_timeline',
    description:
      'Get the authenticated user\'s X (Twitter) timeline (recent tweets). Returns the user\'s own tweets with engagement metrics. Requires X_ACCESS_TOKEN vault secret.',
    inputSchema: LIST_TIMELINE_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { limit?: number };
        const result = await createXClient(ctx);
        if (!result.client) {
          yield { type: 'error', message: result.error || 'Failed to create X client' };
          return;
        }

        const timelineResult = await result.client.getTimeline(Number(args.limit) || 20);

        if (timelineResult.error) {
          yield { type: 'error', message: timelineResult.error };
        } else {
          yield {
            type: 'result',
            value: {
              count: timelineResult.tweets.length,
              tweets: timelineResult.tweets.map((tweet) => ({
                id: tweet.id,
                text: tweet.text,
                created_at: tweet.created_at,
                likes: tweet.public_metrics?.like_count ?? 0,
                replies: tweet.public_metrics?.reply_count ?? 0,
                retweets: tweet.public_metrics?.retweet_count ?? 0,
                url: `https://twitter.com/i/web/status/${tweet.id}`,
              })),
            },
          };
        }
      },
    },
  };

  return [postTweetTool, searchTool, getProfileTool, listTimelineTool];
}
