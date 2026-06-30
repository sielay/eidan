// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import { currentPrincipal } from '@matatbread/matbot-plugin-api';
import { RedditDb } from './db.js';
import { RedditClient } from './reddit-client.js';
import { getSecret } from './vault.js';
import { getEngagement } from './engagement.js';

const SEARCH_REDDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['subreddit', 'keywords'],
  properties: {
    subreddit: {
      type: 'string',
      description: 'Target subreddit (e.g., "parenting", "nosurf"). Do not include "r/" prefix.',
    },
    keywords: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      description: 'Keywords to search for (will be OR\'d together)',
    },
    time_window: {
      type: 'integer',
      minimum: 1,
      maximum: 365,
      description: 'Days to search (default 7)',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Max results (default 30)',
    },
  },
};

const GET_TRENDS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['venture'],
  properties: {
    venture: {
      type: 'string',
      description: 'Venture slug (e.g., "mathbuns", "phonekills")',
    },
    days: {
      type: 'integer',
      minimum: 1,
      maximum: 90,
      description: 'Days back to analyze (default 7)',
    },
  },
};

const GENERATE_REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['venture'],
  properties: {
    venture: {
      type: 'string',
      description: 'Venture slug to generate report for',
    },
    days: {
      type: 'integer',
      minimum: 1,
      maximum: 90,
      description: 'Days back to include (default 7)',
    },
  },
};

async function getRedditClient(ctx: ToolContext): Promise<RedditClient | { error: string }> {
  try {
    const clientId = await getSecret(ctx, 'REDDIT_CLIENT_ID', true);
    const clientSecret = await getSecret(ctx, 'REDDIT_CLIENT_SECRET', true);
    const refreshToken = await getSecret(ctx, 'REDDIT_REFRESH_TOKEN', false);

    return new RedditClient(clientId, clientSecret, refreshToken);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Reddit credentials not configured';
    return { error: msg };
  }
}

export function makeRedditTools(db: RedditDb): Tool[] {
  const searchRedditTool: Tool = {
    name: 'search_reddit',
    description:
      'Search a subreddit for posts matching keywords. Results are cached to avoid re-scraping. Returns ranked posts by engagement.',
    inputSchema: SEARCH_REDDIT_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as {
          subreddit?: string;
          keywords?: string[];
          time_window?: number;
          limit?: number;
        };

        const subreddit = String(args.subreddit ?? '').trim();
        const keywords = Array.isArray(args.keywords) ? args.keywords : [];
        const timeWindow = args.time_window ?? 7;
        const limit = args.limit ?? 30;

        if (!subreddit) {
          yield { type: 'error', message: 'subreddit is required' };
          return;
        }
        if (keywords.length === 0) {
          yield { type: 'error', message: 'keywords array cannot be empty' };
          return;
        }

        const clientRes = await getRedditClient(ctx);
        if ('error' in clientRes) {
          yield { type: 'error', message: clientRes.error };
          return;
        }

        const client = clientRes;
        let results;
        try {
          results = await client.searchSubreddit(subreddit, keywords, limit, timeWindow);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Failed to search Reddit';
          yield { type: 'error', message: msg };
          return;
        }

        // Cache results in database (bulk insert to avoid N+1 queries)
        const userId = currentPrincipal().id;
        await db.savePosts(userId, results.map((post) => ({
          post_id: post.post_id,
          subreddit,
          title: post.title,
          author: post.author,
          score: post.score,
          num_comments: post.num_comments,
          url: post.url,
          text_content: post.text_content,
          sentiment: post.sentiment,
          keywords,
          created_utc: post.created_utc,
        })));

        yield {
          type: 'result',
          value: {
            count: results.length,
            posts: results.map((p) => ({
              title: p.title,
              author: p.author,
              score: p.score,
              comments: p.num_comments,
              url: p.url,
              sentiment: p.sentiment,
              engagement: getEngagement(p),
            })),
          },
        };
      },
    },
  };

  const getTrendsTool: Tool = {
    name: 'get_trends',
    description: 'Get trending topics and pain points from cached Reddit posts for a venture.',
    inputSchema: GET_TRENDS_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { venture?: string; days?: number };
        const venture = String(args.venture ?? '').trim();
        const days = args.days ?? 7;

        if (!venture) {
          yield { type: 'error', message: 'venture is required' };
          return;
        }

        const userId = currentPrincipal().id;
        const posts = await db.getTrendsByVenture(userId, venture, days);

        if (posts.length === 0) {
          yield {
            type: 'result',
            value: { message: `No posts found for venture "${venture}" in the last ${days} days` },
          };
          return;
        }

        // Group by sentiment and extract top pain points
        const bySentiment = new Map<string | undefined, typeof posts>();
        for (const post of posts) {
          const key = post.sentiment || 'neutral';
          if (!bySentiment.has(key)) bySentiment.set(key, []);
          bySentiment.get(key)!.push(post);
        }

        const trends = {
          venture,
          period_days: days,
          total_posts: posts.length,
          by_sentiment: Object.fromEntries(
            Array.from(bySentiment.entries()).map(([sentiment, group]) => [
              sentiment,
              {
                count: group.length,
                top_posts: group.slice(0, 5).map((p) => ({
                  title: p.title,
                  engagement: getEngagement(p),
                  url: p.url,
                })),
              },
            ]),
          ),
        };

        yield { type: 'result', value: trends };
      },
    },
  };

  const generateReportTool: Tool = {
    name: 'generate_report',
    description: 'Generate a markdown report of market insights for a venture based on cached Reddit posts.',
    inputSchema: GENERATE_REPORT_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { venture?: string; days?: number };
        const venture = String(args.venture ?? '').trim();
        const days = args.days ?? 7;

        if (!venture) {
          yield { type: 'error', message: 'venture is required' };
          return;
        }

        const userId = currentPrincipal().id;
        const posts = await db.getTrendsByVenture(userId, venture, days);

        if (posts.length === 0) {
          yield {
            type: 'result',
            value: {
              markdown: `# Research Report: ${venture}\n\nNo posts found in the last ${days} days.`,
            },
          };
          return;
        }

        // Group by sentiment
        const bySentiment = new Map<string | undefined, typeof posts>();
        for (const post of posts) {
          const key = post.sentiment || 'neutral';
          if (!bySentiment.has(key)) bySentiment.set(key, []);
          bySentiment.get(key)!.push(post);
        }

        let markdown = `# Research Report: ${venture}\n\n`;
        markdown += `**Period:** Last ${days} days  \n`;
        markdown += `**Total Posts Analyzed:** ${posts.length}  \n\n`;

        // Pain points (frustration sentiment)
        const frustrationPosts = bySentiment.get('frustration') || [];
        if (frustrationPosts.length > 0) {
          markdown += `## Key Pain Points\n\n`;
          for (const post of frustrationPosts.slice(0, 5)) {
            markdown += `- **${post.title}** (${getEngagement(post)} engagement)\n`;
          }
          markdown += '\n';
        }

        // Seeking help
        const helpPosts = bySentiment.get('seeking_help') || [];
        if (helpPosts.length > 0) {
          markdown += `## Users Seeking Solutions\n\n`;
          markdown += `${helpPosts.length} posts with users asking for help\n\n`;
        }

        // Positive sentiment
        const positivePosts = bySentiment.get('positive') || [];
        if (positivePosts.length > 0) {
          markdown += `## Positive Mentions\n\n`;
          for (const post of positivePosts.slice(0, 3)) {
            markdown += `- ${post.title}\n`;
          }
          markdown += '\n';
        }

        markdown += `## Top Discussions by Engagement\n\n`;
        for (const post of posts.slice(0, 10)) {
          markdown += `- [${post.title}](${post.url}) - ${getEngagement(post)} engagement\n`;
        }

        if (posts.length > 0) {
          const subreddits = Array.from(new Set(posts.map((p) => p.subreddit)));
          markdown += `\n*Report generated from: ${subreddits.map((sr) => `r/${sr}`).join(', ')}*\n`;
        }

        yield { type: 'result', value: { markdown } };
      },
    },
  };

  return [searchRedditTool, getTrendsTool, generateReportTool];
}
