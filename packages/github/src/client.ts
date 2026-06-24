// SPDX-License-Identifier: AGPL-3.0-or-later
// GitHub API client using a Personal Access Token. Stateless: the constructor takes a PAT
// (supplied by the resolver from a connected account). Each call uses the PAT directly in the
// Authorization header. Base host is fixed to https://api.github.com (no SSRF).
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

  private async request<T>(path: string): Promise<{ ok: boolean; data?: T; error?: string }> {
    try {
      const url = `${API_BASE}${path}`;
      const res = await fetch(url, {
        headers: {
          authorization: `Bearer ${this.pat}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': API_VERSION,
          'user-agent': USER_AGENT,
        },
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
      return { ok: true, data: json };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  }

  // Verify the PAT works by fetching the authenticated user.
  async verify(): Promise<{ ok: boolean; login?: string; error?: string }> {
    if (!this.pat) {
      return { ok: false, error: 'PAT is required' };
    }
    const result = await this.request<GitHubUser>('/user');
    if (!result.ok) {
      return { ok: false, error: result.error ?? 'verification failed' };
    }
    const login = result.data?.login;
    if (login) {
      return { ok: true, login };
    }
    return { ok: true };
  }

  // List repos accessible to the authenticated user.
  async listRepos(): Promise<{ ok: boolean; repos?: Array<{ full_name: string; private: boolean; description: string | null; default_branch: string; html_url: string; updated_at: string }>; error?: string }> {
    const result = await this.request<GitHubRepo[]>('/user/repos?per_page=100&sort=updated');
    if (!result.ok) {
      return { ok: false, error: result.error ?? 'failed to list repos' };
    }
    const repos = (result.data ?? []).map((r) => ({
      full_name: r.full_name ?? '',
      private: r.private ?? false,
      description: r.description ?? null,
      default_branch: r.default_branch ?? '',
      html_url: r.html_url ?? '',
      updated_at: r.updated_at ?? '',
    }));
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
    const r = result.data;
    return {
      ok: true,
      repo: {
        full_name: r?.full_name ?? '',
        private: r?.private ?? false,
        description: r?.description ?? null,
        default_branch: r?.default_branch ?? '',
        html_url: r?.html_url ?? '',
        updated_at: r?.updated_at ?? '',
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
    if (!data?.content || data.encoding !== 'base64') {
      return { ok: false, error: 'File content not in expected format' };
    }

    try {
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      if (content.length > 256 * 1024) {
        return { ok: false, error: 'File exceeds 256KB limit' };
      }
      return { ok: true, content, html_url: data.html_url ?? '' };
    } catch (err) {
      return { ok: false, error: 'Failed to decode file content' };
    }
  }

  // List issues for a repo.
  async listIssues(
    repo: string,
    state?: string,
  ): Promise<{ ok: boolean; issues?: Array<{ number: number; title: string; state: string; html_url: string; body: string | null; author: string; created_at: string }>; error?: string }> {
    if (!repo) {
      return { ok: false, error: 'repo is required' };
    }
    const stateParam = state && ['open', 'closed', 'all'].includes(state) ? state : 'open';
    const result = await this.request<GitHubIssue[]>(`/repos/${repo}/issues?state=${stateParam}&per_page=100`);
    if (!result.ok) {
      return { ok: false, error: result.error ?? 'failed to list issues' };
    }
    const issues = (result.data ?? []).map((i) => ({
      number: i.number ?? 0,
      title: i.title ?? '',
      state: i.state ?? '',
      html_url: i.html_url ?? '',
      body: i.body ?? null,
      author: i.user?.login ?? 'unknown',
      created_at: i.created_at ?? '',
    }));
    return { ok: true, issues };
  }

  // Create an issue for a repo.
  async createIssue(
    repo: string,
    title: string,
    body?: string,
  ): Promise<{ ok: boolean; issue?: { number: number; html_url: string }; error?: string }> {
    if (!repo || !title) return { ok: false, error: 'repo and title are required' };
    try {
      const res = await fetch(`${API_BASE}/repos/${repo}/issues`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.pat}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': API_VERSION,
          'user-agent': USER_AGENT,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ title, body: body ?? '' }),
      });

      if (res.status === 401 || res.status === 403) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        const msg = data.message ?? (res.status === 401 ? 'Invalid token' : 'Access denied');
        return { ok: false, error: msg };
      }

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        return { ok: false, error: data.message ?? `Create failed (${res.status})` };
      }

      const issue = (await res.json()) as { number?: number; html_url?: string };
      return { ok: true, issue: { number: issue.number ?? 0, html_url: issue.html_url ?? '' } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  }

  // List pull requests for a repo.
  async listPRs(
    repo: string,
    state?: string,
  ): Promise<{ ok: boolean; prs?: Array<{ number: number; title: string; state: string; html_url: string; body: string | null; author: string; created_at: string }>; error?: string }> {
    if (!repo) {
      return { ok: false, error: 'repo is required' };
    }
    const stateParam = state && ['open', 'closed', 'all'].includes(state) ? state : 'open';
    const result = await this.request<GitHubPR[]>(`/repos/${repo}/pulls?state=${stateParam}&per_page=100`);
    if (!result.ok) {
      return { ok: false, error: result.error ?? 'failed to list prs' };
    }
    const prs = (result.data ?? []).map((p) => ({
      number: p.number ?? 0,
      title: p.title ?? '',
      state: p.state ?? '',
      html_url: p.html_url ?? '',
      body: p.body ?? null,
      author: p.user?.login ?? 'unknown',
      created_at: p.created_at ?? '',
    }));
    return { ok: true, prs };
  }

  // Search code across all accessible repos.
  async searchCode(query: string, repo?: string): Promise<{ ok: boolean; results?: Array<{ name: string; path: string; repo: string; html_url: string }>; error?: string }> {
    if (!query) {
      return { ok: false, error: 'query is required' };
    }
    let q = query;
    if (repo) {
      q += ` repo:${repo}`;
    }
    const encoded = encodeURIComponent(q);
    const result = await this.request<GitHubSearchResult>(`/search/code?q=${encoded}&per_page=50`);
    if (!result.ok) {
      return { ok: false, error: result.error ?? 'failed to search code' };
    }
    const results = (result.data?.items ?? []).map((i) => ({
      name: i.name ?? '',
      path: i.path ?? '',
      repo: i.repository?.full_name ?? '',
      html_url: i.html_url ?? '',
    }));
    return { ok: true, results };
  }
}
