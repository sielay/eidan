// SPDX-License-Identifier: AGPL-3.0-or-later
// Mastodon API client. Federated: bound to a single instance host + a bearer access token. The token
// and host come from a connected account (resolved by the kit) or the legacy single-secret fallback.
import type { Status, Account, SearchResults, CreateStatusRequest } from './types.js';

export class MastodonClient {
  private instance: string;
  private accessToken: string;

  constructor(accessToken: string, host: string) {
    this.accessToken = accessToken;
    const h = host.startsWith('http') ? host : `https://${host}`;
    this.instance = h.replace(/\/$/, '');
  }

  private getHeaders(): HeadersInit {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  async verifyCredentials(): Promise<Account | null> {
    try {
      const res = await fetch(`${this.instance}/api/v1/accounts/verify_credentials`, {
        headers: this.getHeaders(),
      });

      if (!res.ok) {
        return null;
      }

      return (await res.json()) as Account;
    } catch {
      return null;
    }
  }

  async post(
    text: string,
    options?: { replyTo?: string; visibility?: 'public' | 'unlisted' | 'private' | 'direct' }
  ): Promise<{ id?: string; url?: string; error?: string }> {
    try {
      const body: CreateStatusRequest = {
        status: text,
        visibility: options?.visibility || 'public',
      };

      if (options?.replyTo) {
        body.in_reply_to_id = options.replyTo;
      }

      const res = await fetch(`${this.instance}/api/v1/statuses`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errorData = await res.text();
        return { error: `Failed to post: ${res.status} ${errorData}` };
      }

      const data = (await res.json()) as Status;
      return { id: data.id, url: data.url };
    } catch (err) {
      return { error: `Failed to post to Mastodon: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async search(query: string, limit: number = 20): Promise<{ statuses?: Status[]; error?: string }> {
    try {
      const url = new URL(`${this.instance}/api/v2/search`);
      url.searchParams.set('q', query);
      url.searchParams.set('type', 'statuses');
      url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 40)));

      const res = await fetch(url.toString(), {
        headers: this.getHeaders(),
      });

      if (!res.ok) {
        return { error: `Search failed: ${res.status}` };
      }

      const data = (await res.json()) as SearchResults;
      return { statuses: data.statuses };
    } catch (err) {
      return { error: `Failed to search Mastodon: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async getProfile(accountId?: string): Promise<{ account?: Account; error?: string }> {
    try {
      let url: string;

      if (accountId) {
        url = `${this.instance}/api/v1/accounts/${accountId}`;
      } else {
        const credentials = await this.verifyCredentials();
        if (!credentials) {
          return { error: 'Failed to verify credentials' };
        }
        url = `${this.instance}/api/v1/accounts/${credentials.id}`;
      }

      const res = await fetch(url, {
        headers: this.getHeaders(),
      });

      if (!res.ok) {
        return { error: `Failed to get profile: ${res.status}` };
      }

      const account = (await res.json()) as Account;
      return { account };
    } catch (err) {
      return { error: `Failed to get profile: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async getTimeline(
    type: 'home' | 'local' | 'federated' = 'home',
    limit: number = 20
  ): Promise<{ statuses?: Status[]; error?: string }> {
    try {
      let endpoint: string;
      switch (type) {
        case 'local':
          endpoint = '/api/v1/timelines/public';
          break;
        case 'federated':
          endpoint = '/api/v1/timelines/public';
          break;
        default:
          endpoint = '/api/v1/timelines/home';
      }

      const url = new URL(`${this.instance}${endpoint}`);
      url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 40)));

      if (type === 'local') {
        url.searchParams.set('local', 'true');
      }

      const res = await fetch(url.toString(), {
        headers: this.getHeaders(),
      });

      if (!res.ok) {
        return { error: `Failed to fetch timeline: ${res.status}` };
      }

      const data = (await res.json()) as Status[];
      return { statuses: data };
    } catch (err) {
      return { error: `Failed to fetch timeline: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
