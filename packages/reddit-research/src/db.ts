// SPDX-License-Identifier: AGPL-3.0-or-later
import { Pool } from 'pg';

export interface RedditPost {
  id: string;
  post_id: string;
  subreddit: string;
  title: string;
  author: string;
  score: number;
  num_comments: number;
  url: string;
  text_content: string | undefined;
  sentiment: string | null;
  keywords: string[];
  created_utc: number;
  fetched_at: Date;
}

export interface RedditVenture {
  id: string;
  venture: string;
  subreddit: string;
  keywords: string[];
  sentiment_keywords: string[];
}

export class RedditDb {
  private pool: Pool;

  constructor(connectionUrl: string) {
    this.pool = new Pool({ connectionString: connectionUrl });
  }

  async savePost(userId: string, post: Omit<RedditPost, 'id' | 'fetched_at'>): Promise<RedditPost> {
    const result = await this.pool.query(
      `insert into eidan.reddit_posts (user_id, post_id, subreddit, title, author, score, num_comments, url, text_content, sentiment, keywords, created_utc)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (user_id, post_id) where deleted_at is null do update
       set score = excluded.score, num_comments = excluded.num_comments, updated_at = now()
       returning *`,
      [
        userId,
        post.post_id,
        post.subreddit,
        post.title,
        post.author,
        post.score,
        post.num_comments,
        post.url,
        post.text_content || null,
        post.sentiment || null,
        post.keywords || [],
        post.created_utc,
      ],
    );
    return result.rows[0];
  }

  async getPostsBySubreddit(
    userId: string,
    subreddit: string,
    days: number = 7,
    limit: number = 50,
  ): Promise<RedditPost[]> {
    const result = await this.pool.query(
      `select * from eidan.reddit_posts
       where user_id = $1 and subreddit = $2 and created_utc > extract(epoch from now()) - ($3 * 86400)
       and deleted_at is null
       order by created_utc desc
       limit $4`,
      [userId, subreddit, days, limit],
    );
    return result.rows;
  }

  async getTrendsByVenture(userId: string, venture: string, days: number = 7): Promise<RedditPost[]> {
    const result = await this.pool.query(
      `select p.* from eidan.reddit_posts p
       where p.user_id = $1
       and p.subreddit in (
         select subreddit from eidan.reddit_ventures
         where user_id = $1 and venture = $2 and deleted_at is null
       )
       and p.created_utc > extract(epoch from now()) - ($3 * 86400)
       and p.deleted_at is null
       order by p.score + p.num_comments desc
       limit 50`,
      [userId, venture, days],
    );
    return result.rows;
  }

  async getVentures(userId: string): Promise<RedditVenture[]> {
    const result = await this.pool.query(
      `select id, venture, subreddit, keywords, sentiment_keywords from eidan.reddit_ventures
       where user_id = $1 and deleted_at is null`,
      [userId],
    );
    return result.rows;
  }

  async upsertVenture(
    userId: string,
    venture: string,
    subreddit: string,
    keywords?: string[],
    sentimentKeywords?: string[],
  ): Promise<RedditVenture> {
    const result = await this.pool.query(
      `insert into eidan.reddit_ventures (user_id, venture, subreddit, keywords, sentiment_keywords)
       values ($1, $2, $3, $4, $5)
       on conflict (user_id, venture, subreddit) where deleted_at is null do update
       set keywords = excluded.keywords, sentiment_keywords = excluded.sentiment_keywords, updated_at = now()
       returning id, venture, subreddit, keywords, sentiment_keywords`,
      [userId, venture, subreddit, keywords || [], sentimentKeywords || []],
    );
    return result.rows[0];
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
