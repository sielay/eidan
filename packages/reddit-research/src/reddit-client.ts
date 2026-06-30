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
  text_content: string | null;
  created_utc: number;
  sentiment: string | null;
}

export class RedditClient {
  private reddit: Snoowrap;

  constructor(clientId: string, clientSecret: string, refreshToken?: string | undefined) {
    const customUserAgent = process.env['REDDIT_USER_AGENT'];
    // Sanitize custom user agent: reject if it contains newlines or excessive length that could be injection vector
    const userAgent = customUserAgent && /^[\w\-\.\+\(\)\/ :]+$/.test(customUserAgent) && customUserAgent.length <= 128
      ? customUserAgent
      : 'Eidan-Reddit-Research/0.1.0 (+https://github.com/sielay/eidan)';

    const opts: ConstructorParameters<typeof Snoowrap>[0] = {
      clientId,
      clientSecret,
      userAgent,
    };

    if (refreshToken) {
      opts.refreshToken = refreshToken;
    }

    this.reddit = new Snoowrap(opts);
  }

  async searchSubreddit(subredditName: string, keywords: string[], limit: number = 50, timeWindowDays?: number): Promise<RedditSearchResult[]> {
    const sr = this.reddit.getSubreddit(subredditName);
    const searchQuery = keywords.join(' OR ');

    const timeWindow = this.convertDaysToTimeParam(timeWindowDays ?? 7);
    // ponytail: fetch more posts to rank by engagement client-side (score + comments) rather than relying on Reddit's default sort.
    // Multiplier of 2 is a pragmatic balance: minimizes API calls while ensuring ranked results are representative.
    // If performance becomes an issue with large limit, reduce to 1.5x and/or check if Reddit API supports engagement-based sorting.
    const internalLimit = Math.max(limit * 2, 100);
    const postsIterable = await sr.search({
      query: searchQuery,
      sort: 'top',
      time: timeWindow,
      limit: internalLimit,
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
        text_content: post.selftext || null,
        created_utc: post.created_utc,
        sentiment: this.detectSentiment(post.title, post.selftext) ?? null,
      });
    }
    // sort by engagement metric (upvotes + comments) and return top results
    posts.sort((a, b) => (b.score + b.num_comments) - (a.score + a.num_comments));
    return posts.slice(0, limit);
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
        text_content: post.selftext || null,
        created_utc: post.created_utc,
        sentiment: this.detectSentiment(post.title, post.selftext) ?? null,
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
    // ponytail: simple keyword-based sentiment classification.
    // Known limitation: context-insensitive, so 'overcame a difficult challenge' scores as frustration.
    // Basic negation check for 'help' to avoid false positives like "need help avoiding frustration".
    const text = `${title} ${content || ''}`.toLowerCase();
    const frustrationCount = FRUSTRATION_KEYWORDS.filter((kw) => text.includes(kw)).length;

    if (frustrationCount >= 2) return 'frustration';
    if (frustrationCount === 1 && text.includes('help')) {
      // Avoid classifying posts with negated help (e.g., "don't need help", "no help avoiding X")
      const hasNegation = /(?:not|don't|didn't|can't|won't|no)\s+\w*help/.test(text);
      if (!hasNegation) return 'seeking_help';
    }
    if (text.includes('love') || text.includes('great') || text.includes('amazing')) return 'positive';
    return undefined;
  }
}
