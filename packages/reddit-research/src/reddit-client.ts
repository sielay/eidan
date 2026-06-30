// SPDX-License-Identifier: AGPL-3.0-or-later
import Snoowrap from 'snoowrap';

const FRUSTRATION_KEYWORDS = [
  'struggling', 'frustrated', 'difficult', 'problem', 'help', 'issue', 'broken',
  'confused', 'don\'t understand', 'can\'t figure out', 'stuck', 'fail', 'pain',
  'complaint', 'terrible', 'awful', 'hate', 'worst', 'regret', 'waste',
];

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

  constructor(clientId: string, clientSecret: string, refreshToken?: string | undefined) {
    const opts = {
      clientId,
      clientSecret,
      userAgent: 'Eidan-Reddit-Research/0.1 (+https://github.com/sielay/eidan)',
    } as Record<string, string>;

    if (refreshToken) {
      opts.refreshToken = refreshToken;
    }

    this.reddit = new Snoowrap(opts as unknown as ConstructorParameters<typeof Snoowrap>[0]);
  }

  async searchSubreddit(subredditName: string, keywords: string[], limit: number = 50): Promise<RedditSearchResult[]> {
    const sr = this.reddit.getSubreddit(subredditName);
    const searchQuery = keywords.join(' OR ');

    const postsIterable = await sr.search({
      query: searchQuery,
      sort: 'top',
      time: 'year',
    } as any);

    const posts: RedditSearchResult[] = [];
    let count = 0;
    // ponytail: snoowrap types have circular reference issues with async iteration, suppress with 'as any'
    for await (const post of postsIterable as any) {
      if (count >= limit) break;
      const author = (post as any).author && typeof (post as any).author === 'object' && 'name' in (post as any).author
        ? ((post as any).author as { name: string }).name
        : '[deleted]';
      posts.push({
        post_id: (post as any).id,
        title: (post as any).title,
        author,
        score: (post as any).score,
        num_comments: (post as any).num_comments,
        url: (post as any).url,
        text_content: ((post as any).selftext || undefined) as string | undefined,
        created_utc: (post as any).created_utc,
        sentiment: this.detectSentiment((post as any).title, (post as any).selftext) ?? undefined,
      });
      count++;
    }
    return posts;
  }

  async getNewPosts(subredditName: string, limit: number = 30): Promise<RedditSearchResult[]> {
    const sr = this.reddit.getSubreddit(subredditName);
    const postsIterable = await sr.getNew();

    const posts: RedditSearchResult[] = [];
    let count = 0;
    // ponytail: snoowrap types have circular reference issues with async iteration, suppress with 'as any'
    for await (const post of postsIterable as any) {
      if (count >= limit) break;
      const author = (post as any).author && typeof (post as any).author === 'object' && 'name' in (post as any).author
        ? ((post as any).author as { name: string }).name
        : '[deleted]';
      posts.push({
        post_id: (post as any).id,
        title: (post as any).title,
        author,
        score: (post as any).score,
        num_comments: (post as any).num_comments,
        url: (post as any).url,
        text_content: ((post as any).selftext || undefined) as string | undefined,
        created_utc: (post as any).created_utc,
        sentiment: this.detectSentiment((post as any).title, (post as any).selftext) ?? undefined,
      });
      count++;
    }
    return posts;
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
