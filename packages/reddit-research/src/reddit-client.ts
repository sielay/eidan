// SPDX-License-Identifier: AGPL-3.0-or-later
// Reddit read-only research via plain `fetch` against Reddit's OAuth API — no SDK (matbot doctrine;
// mirrors the LLM provider adapters + the github client). App-only client-credentials OAuth by default;
// supplying a refresh token switches to the installed-app flow. The token is cached until it expires.

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
  text_content: string | null;
  created_utc: number;
  sentiment: string | null;
}

interface RawPost {
  id: string;
  title: string;
  author: string;
  score: number;
  num_comments: number;
  url: string;
  selftext?: string;
  created_utc: number;
}

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const OAUTH_BASE = 'https://oauth.reddit.com';
// Reddit caps a listing at 100 items per request; we fetch up to that and rank client-side.
const MAX_LISTING = 100;

export class RedditClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string | undefined;
  private readonly userAgent: string;
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(clientId: string, clientSecret: string, refreshToken?: string | undefined) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    const custom = process.env['REDDIT_USER_AGENT'];
    // Sanitize a custom user-agent: reject newlines / over-length that could be a header-injection vector.
    this.userAgent = custom && /^[\w\-.+()/ :]+$/.test(custom) && custom.length <= 128
      ? custom
      : 'Eidan-Reddit-Research/0.1.0 (+https://github.com/sielay/eidan)';
  }

  // Client-credentials (or refresh-token) access token, cached until ~30s before expiry.
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - 30_000) return this.token;
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const body = this.refreshToken
      ? new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.refreshToken })
      : new URLSearchParams({ grant_type: 'client_credentials' });
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': this.userAgent,
      },
      body,
    });
    if (!resp.ok) throw new Error(`Reddit auth failed: HTTP ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    const data = (await resp.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error('Reddit auth: no access_token in response');
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
    return this.token;
  }

  // GET a listing endpoint and normalise its children into RawPosts.
  private async getListing(path: string): Promise<RawPost[]> {
    const token = await this.accessToken();
    const resp = await fetch(`${OAUTH_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': this.userAgent },
    });
    if (!resp.ok) throw new Error(`Reddit API ${path} failed: HTTP ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    const data = (await resp.json()) as { data?: { children?: Array<{ data?: Record<string, unknown> }> } };
    return (data.data?.children ?? []).map((c) => {
      const p = c.data ?? {};
      return {
        id: String(p['id'] ?? ''),
        title: String(p['title'] ?? ''),
        author: typeof p['author'] === 'string' ? p['author'] : '[deleted]',
        score: Number(p['score'] ?? 0),
        num_comments: Number(p['num_comments'] ?? 0),
        url: String(p['url'] ?? ''),
        ...(typeof p['selftext'] === 'string' ? { selftext: p['selftext'] } : {}),
        created_utc: Number(p['created_utc'] ?? 0),
      };
    });
  }

  private toResult(p: RawPost): RedditSearchResult {
    return {
      post_id: p.id,
      title: p.title,
      author: p.author,
      score: p.score,
      num_comments: p.num_comments,
      url: p.url,
      text_content: p.selftext || null,
      created_utc: p.created_utc,
      sentiment: this.detectSentiment(p.title, p.selftext) ?? null,
    };
  }

  async searchSubreddit(subredditName: string, keywords: string[], limit = 50, timeWindowDays?: number): Promise<RedditSearchResult[]> {
    const q = encodeURIComponent(keywords.join(' OR '));
    const time = this.convertDaysToTimeParam(timeWindowDays ?? 7);
    // Fetch up to the API cap and rank by engagement (score + comments) client-side, then trim to `limit`.
    const fetchLimit = Math.min(Math.max(limit * 2, 100), MAX_LISTING);
    const sr = encodeURIComponent(subredditName);
    const raw = await this.getListing(`/r/${sr}/search?q=${q}&restrict_sr=1&sort=top&t=${time}&limit=${fetchLimit}&raw_json=1`);
    const posts = raw.map((p) => this.toResult(p));
    posts.sort((a, b) => (b.score + b.num_comments) - (a.score + a.num_comments));
    return posts.slice(0, limit);
  }

  async getNewPosts(subredditName: string, limit = 30): Promise<RedditSearchResult[]> {
    const sr = encodeURIComponent(subredditName);
    const raw = await this.getListing(`/r/${sr}/new?limit=${Math.min(limit, MAX_LISTING)}&raw_json=1`);
    return raw.map((p) => this.toResult(p));
  }

  private convertDaysToTimeParam(days: number): 'day' | 'week' | 'month' | 'year' | 'all' {
    if (days <= 1) return 'day';
    if (days <= 7) return 'week';
    if (days <= 30) return 'month';
    if (days <= 365) return 'year';
    return 'all';
  }

  private detectSentiment(title: string, content?: string): string | undefined {
    // Simple keyword-based sentiment classification. Known limitation: context-insensitive, so
    // 'overcame a difficult challenge' scores as frustration. Basic negation check for 'help'.
    const text = `${title} ${content || ''}`.toLowerCase();
    const frustrationCount = FRUSTRATION_KEYWORDS.filter((kw) => text.includes(kw)).length;

    if (frustrationCount >= 2) return 'frustration';
    if (frustrationCount === 1 && text.includes('help')) {
      const hasNegation = /(?:not|don't|didn't|can't|won't|no)\s+\w*help/.test(text);
      if (!hasNegation) return 'seeking_help';
    }
    if (text.includes('love') || text.includes('great') || text.includes('amazing')) return 'positive';
    return undefined;
  }
}
