// SPDX-License-Identifier: AGPL-3.0-or-later
// GitHub API client using a Personal Access Token. Stateless: the constructor takes a PAT
// (supplied by the resolver from a connected account). Each call uses the PAT directly in the
// Authorization header. Base host is fixed to https://api.github.com (no SSRF).

import { Buffer } from 'buffer';

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'eidan-github-plugin';

interface GitHubUser {
  login?: string;
  id?: number;
}

interface GitHubRepo {
  full_name?: string;
  private?: boolean;
  description?: string | null;
  default_branch?: string;
  html_url?: string;
  updated_at?: string;
}

interface GitHubIssue {
  number?: number;
  title?: string;
  state?: string;
  html_url?: string;
  body?: string | null;
  user?: { login?: string };
  created_at?: string;
}

interface GitHubPR {
  number?: number;
  title?: string;
  state?: string;
  html_url?: string;
  body?: string | null;
  user?: { login?: string };
  created_at?: string;
}

interface GitHubFileContent {
  content?: string;
  encoding?: string;
  html_url?: string;
}

interface GitHubSearchResult {
  items?: Array<{
    name?: string;
    path?: string;
    repository?: { full_name?: string };
    html_url?: string;
  }>;
}

export class GitHubClient {
  private pat: string;

  constructor(pat: string) {
    this.pat = pat;
  }

  private async request<T>(
    path: string,
    options?: { method?: string; body?: unknown },
  ): Promise<{ ok: boolean; data?: T; nextUrl?: string; error?: string }> {
    try {
      const url = `${API_BASE}${path}`;
      const res = await fetch(url, {
        method: options?.method ?? 'GET',
        headers: {
          authorization: `Bearer ${this.pat}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': API_VERSION,
          'user-agent': USER_AGENT,
          ...(options?.body ? { 'content-type': 'application/json' } : {}),
        },
        ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
      });

      if (res.status === 401 || res.status === 403) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        const msg = data.message ?? (res.status === 401 ? 'Invalid token' : 'Access denied');
        return { ok: false, error: msg };
      }

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        return { ok: false, error: data.message ?? `Request failed (${res.status})` };
      }

      const json = (await res.json()) as T;
      const linkHeader = res.headers.get('link');
      const nextUrl = this.parseLink(linkHeader)?.next;
      const result: { ok: boolean; data?: T; nextUrl?: string; error?: string } = { ok: true, data: json };
      if (nextUrl) result.nextUrl = nextUrl;
      return result;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  }

  private parseLink(linkHeader: string | null): { next?: string } {
    const links: { next?: string } = {};
    if (!linkHeader) return links;
    for (const link of linkHeader.split(',')) {
      const m = link.match(/<([^>]+)>;\s*rel="([^"]+)"/);
      if (m && m[2] === 'next' && m[1]) {
        try {
          const parsed = new URL(m[1]);
          links.next = parsed.pathname + parsed.search;
        } catch {
          // If URL parsing fails, skip this link
        }
      }
    }
    return links;
  }

  // Verify the PAT works by fetching the authenticated user.
  async verify(): Promise<{ ok: boolean; login?: string; id?: number; error?: string }> {
    if (!this.pat) {
      return { ok: false, error: 'PAT is required' };
    }
    const result = await this.request<GitHubUser>('/user');
    if (!result.ok) {
      return { ok: false, error: result.error ?? 'verification failed' };
    }
    const returnVal: { ok: boolean; login?: string; id?: number; error?: string } = { ok: true };
    if (result.data?.login) returnVal.login = result.data.login;
    if (result.data?.id) returnVal.id = result.data.id;
    return returnVal;
  }

  // List repos accessible to the authenticated user (paginated).
  async listRepos(): Promise<{ ok: boolean; repos?: Array<{ full_name: string; private: boolean; description: string | null; default_branch: string; html_url: string; updated_at: string }>; error?: string }> {
    const repos: Array<{ full_name: string; private: boolean; description: string | null; default_branch: string; html_url: string; updated_at: string }> = [];
    let url = '/user/repos?per_page=100&sort=updated';
    while (url) {
      const result = await this.request<GitHubRepo[]>(url);
      if (!result.ok) {
        return { ok: false, error: result.error ?? 'failed to list repos' };
      }
      const batch = (result.data ?? []).map((r) => ({
        full_name: r.full_name ?? '',
        private: r.private ?? false,
        description: r.description ?? null,
        default_branch: r.default_branch ?? '',
        html_url: r.html_url ?? '',
        updated_at: r.updated_at ?? '',
      }));
      repos.push(...batch);
      url = result.nextUrl || '';
    }
    return { ok: true, repos };
  }

  // Get metadata for a specific repo.
  async getRepo(repo: string): Promise<{ ok: boolean; repo?: { full_name: string; private: boolean; description: string | null; default_branch: string; html_url: string; updated_at: string }; error?: string }> {
    if (!repo) {
      return { ok: false, error: 'repo is required' };
    }
    const result = await this.request<GitHubRepo>(`/repos/${repo}`);
    if (!result.ok) {
      return { ok: false, error: result.error ?? 'failed to get repo' };
    }
    const { full_name = '', private: isPrivate = false, description = null, default_branch = '', html_url = '', updated_at = '' } = result.data ?? {};
    return {
      ok: true,
      repo: {
        full_name,
        private: isPrivate,
        description,
        default_branch,
        html_url,
        updated_at,
      },
    };
  }

  // Read a file from a repo (base64-decoded, max ~256KB).
  async readFile(
    repo: string,
    path: string,
    ref?: string,
  ): Promise<{ ok: boolean; content?: string; html_url?: string; error?: string }> {
    if (!repo || !path) {
      return { ok: false, error: 'repo and path are required' };
    }
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const result = await this.request<GitHubFileContent>(`/repos/${repo}/contents/${path}${query}`);
    if (!result.ok) {
      return { ok: false, error: result.error ?? 'failed to read file' };
    }

    const data = result.data;
    if (!data?.content || typeof data.content !== 'string' || data.encoding !== 'base64') {
      return { ok: false, error: 'File content not in expected format' };
    }

    // Check encoded size before decoding to prevent memory exhaustion.
    const MAX_ENCODED_SIZE = 512 * 1024;
    if (data.content.length > MAX_ENCODED_SIZE) {
      return { ok: false, error: 'Encoded file size exceeds limit' };
    }

    try {
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      if (content.length > 256 * 1024) {
        return { ok: false, error: 'File exceeds 256 kilobytes limit' };
      }
      return { ok: true, content, html_url: data.html_url ?? '' };
    } catch (err) {
      return { ok: false, error: 'Failed to decode file content' };
    }
  }

  // List issues for a repo (paginated).
  async listIssues(
    repo: string,
    state?: string,
  ): Promise<{ ok: boolean; issues?: Array<{ number: number; title: string; state: string; html_url: string; body: string | null; author: string; created_at: string }>; error?: string }> {
    if (!repo) {
      return { ok: false, error: 'repo is required' };
    }
    const stateParam = state && ['open', 'closed', 'all'].includes(state) ? state : 'open';
    const issues: Array<{ number: number; title: string; state: string; html_url: string; body: string | null; author: string; created_at: string }> = [];
    let url = `/repos/${repo}/issues?state=${stateParam}&per_page=100`;
    while (url) {
      const result = await this.request<GitHubIssue[]>(url);
      if (!result.ok) {
        return { ok: false, error: result.error ?? 'failed to list issues' };
      }
      const batch = (result.data ?? []).map((i) => ({
        number: i.number ?? 0,
        title: i.title ?? '',
        state: i.state ?? '',
        html_url: i.html_url ?? '',
        body: i.body ?? null,
        author: i.user?.login ?? 'unknown',
        created_at: i.created_at ?? '',
      }));
      issues.push(...batch);
      url = result.nextUrl || '';
    }
    return { ok: true, issues };
  }

  // Create an issue for a repo.
  async createIssue(
    repo: string,
    title: string,
    body?: string,
  ): Promise<{ ok: boolean; issue?: { number: number; html_url: string }; error?: string }> {
    if (!repo || !title) return { ok: false, error: 'repo and title are required' };
    const result = await this.request<{ number?: number; html_url?: string }>(
      `/repos/${repo}/issues`,
      { method: 'POST', body: { title, body: body ?? '' } },
    );
    if (!result.ok) {
      return { ok: false, error: result.error ?? 'Failed to create issue' };
    }
    const { number, html_url } = result.data ?? {};
    if (typeof number === 'number' && typeof html_url === 'string') {
      return { ok: true, issue: { number, html_url } };
    }
    return { ok: false, error: 'Invalid response: missing number or url' };
  }

  // List pull requests for a repo (paginated).
  async listPRs(
    repo: string,
    state?: string,
  ): Promise<{ ok: boolean; prs?: Array<{ number: number; title: string; state: string; html_url: string; body: string | null; author: string; created_at: string }>; error?: string }> {
    if (!repo) {
      return { ok: false, error: 'repo is required' };
    }
    const stateParam = state && ['open', 'closed', 'all'].includes(state) ? state : 'open';
    const prs: Array<{ number: number; title: string; state: string; html_url: string; body: string | null; author: string; created_at: string }> = [];
    let url = `/repos/${repo}/pulls?state=${stateParam}&per_page=100`;
    while (url) {
      const result = await this.request<GitHubPR[]>(url);
      if (!result.ok) {
        return { ok: false, error: result.error ?? 'failed to list prs' };
      }
      const batch = (result.data ?? []).map((p) => ({
        number: p.number ?? 0,
        title: p.title ?? '',
        state: p.state ?? '',
        html_url: p.html_url ?? '',
        body: p.body ?? null,
        author: p.user?.login ?? 'unknown',
        created_at: p.created_at ?? '',
      }));
      prs.push(...batch);
      url = result.nextUrl || '';
    }
    return { ok: true, prs };
  }

  // Search code across all accessible repos (paginated, up to 1000 results).
  async searchCode(query: string, repo?: string): Promise<{ ok: boolean; results?: Array<{ name: string; path: string; repo: string; html_url: string }>; error?: string }> {
    if (!query) {
      return { ok: false, error: 'query is required' };
    }
    let q = query;
    if (repo) {
      q += ` repo:${repo}`;
    }
    const encoded = encodeURIComponent(q);
    const results: Array<{ name: string; path: string; repo: string; html_url: string }> = [];
    let url = `/search/code?q=${encoded}&per_page=100`;
    let page = 0;
    while (url && page < 10) {
      const result = await this.request<GitHubSearchResult>(url);
      if (!result.ok) {
        return { ok: false, error: result.error ?? 'failed to search code' };
      }
      const batch = (result.data?.items ?? []).map((i) => ({
        name: i.name ?? '',
        path: i.path ?? '',
        repo: i.repository?.full_name ?? '',
        html_url: i.html_url ?? '',
      }));
      results.push(...batch);
      url = result.nextUrl || '';
      page++;
    }
    return { ok: true, results };
  }
}
