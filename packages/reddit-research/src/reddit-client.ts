// SPDX-License-Identifier: AGPL-3.0-or-later
import Snoowrap from 'snoowrap';

const FRUSTRATION_KEYWORDS = [
  'struggling', 'frustrated', 'difficult', 'problem', 'help', 'issue', 'broken',
  'confused', 'don\'t understand', 'can\'t figure out', 'stuck', 'fail', 'pain',
  'complaint', 'terrible', 'awful', 'hate', 'worst', 'regret', 'waste',
];

interface RedditPost {
  id: string;
  title: string;
  author?: { name: string };
  score: number;
  num_comments: number;
  url: string;
  selftext?: string;
  created_utc: number;
}

export interface RedditSearchResult {
  post_id: string;
  title: string;
  author: string;
  score: number;
  num_comments: number;
  url: string;
  text_content: string | undefined;
  created_utc: number;
  sentiment: string | undefined;
}

export class RedditClient {
  private reddit: Snoowrap;

  constructor(clientId: string, clientSecret: string, refreshToken?: string | undefined, instanceId: string = 'default') {
    // instanceId should not contain sensitive/PII; callers must ensure it's a benign identifier (UUID/generic string)
    const sanitizedInstanceId = instanceId.replace(/[^a-zA-Z0-9-_.]/g, '');
    const opts = {
      clientId,
      clientSecret,
      userAgent: `Eidan-Reddit-Research/0.1 (Instance:${sanitizedInstanceId}; +https://github.com/sielay/eidan)`,
    } as Record<string, string>;

    if (refreshToken) {
      opts.refreshToken = refreshToken;
    }

    this.reddit = new Snoowrap(opts as unknown as ConstructorParameters<typeof Snoowrap>[0]);
  }

  async searchSubreddit(subredditName: string, keywords: string[], limit: number = 50, timeWindowDays?: number): Promise<RedditSearchResult[]> {
    const sr = this.reddit.getSubreddit(subredditName);
    const searchQuery = keywords.join(' OR ');

    const timeWindow = this.convertDaysToTimeParam(timeWindowDays ?? 7);
    // sort 'top' by engagement (upvotes + comments), which is the primary ranking metric for market research
    // pass limit directly to Reddit API for efficient fetching
    const postsIterable = await sr.search({
      query: searchQuery,
      sort: 'top',
      time: timeWindow,
      limit,
    });

    const posts: RedditSearchResult[] = [];
    for await (const post of postsIterable) {
      const author = post.author && typeof post.author === 'object' && 'name' in post.author
        ? post.author.name
        : '[deleted]';
      posts.push({
        post_id: post.id,
        title: post.title,
        author,
        score: post.score,
        num_comments: post.num_comments,
        url: post.url,
        text_content: (post.selftext || undefined) as string | undefined,
        created_utc: post.created_utc,
        sentiment: this.detectSentiment(post.title, post.selftext) ?? undefined,
      });
    }
    return posts;
  }

  async getNewPosts(subredditName: string, limit: number = 30): Promise<RedditSearchResult[]> {
    const sr = this.reddit.getSubreddit(subredditName);
    // pass limit directly to Reddit API for efficient fetching
    const postsIterable = await sr.getNew({ limit });

    const posts: RedditSearchResult[] = [];
    for await (const post of postsIterable) {
      const author = post.author && typeof post.author === 'object' && 'name' in post.author
        ? post.author.name
        : '[deleted]';
      posts.push({
        post_id: post.id,
        title: post.title,
        author,
        score: post.score,
        num_comments: post.num_comments,
        url: post.url,
        text_content: (post.selftext || undefined) as string | undefined,
        created_utc: post.created_utc,
        sentiment: this.detectSentiment(post.title, post.selftext) ?? undefined,
      });
    }
    return posts;
  }

  private convertDaysToTimeParam(days: number): 'day' | 'week' | 'month' | 'year' | 'all' {
    if (days <= 1) return 'day';
    if (days <= 7) return 'week';
    if (days <= 30) return 'month';
    if (days <= 365) return 'year';
    return 'all';
  }

  private detectSentiment(title: string, content?: string): string | undefined {
    const text = `${title} ${content || ''}`.toLowerCase();
    const frustrationCount = FRUSTRATION_KEYWORDS.filter((kw) => text.includes(kw)).length;

    if (frustrationCount >= 2) return 'frustration';
    if (frustrationCount === 1 && text.includes('help')) return 'seeking_help';
    if (text.includes('love') || text.includes('great') || text.includes('amazing')) return 'positive';
    return undefined;
  }
}
