// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent tools for the `github` plugin — read repos, files, issues, PRs; search code; create issues.
//
// Per-account PATs: the operator connects one or more GitHub accounts in the Connections screen
// (each account supplies a Personal Access Token that's sealed in the vault). At call time the tools
// pick the requested account (or the first), resolve the PAT via the connections kit, and build a
// client that uses it directly. Falls back to the legacy single GITHUB_TOKEN secret when no account
// is connected, so older setups keep working.
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import type { SealFn } from './index.js';
import {
  type AccountStore,
  AccountResolveError,
  NotConnectedError,
  resolveAccessToken,
} from '@eidandev/connections-kit';
import { GitHubClient } from './client.js';
import { githubAdapter } from './adapter.js';
import { secretOpt } from './vault.js';

const ACCOUNT_PROP = {
  account: {
    type: 'string',
    description: 'Which connected GitHub account (name or slug). Omit to use the first connected account.',
  },
} as const;

const REPOS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    account: ACCOUNT_PROP.account,
  },
};

const REPO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['repo'],
  properties: {
    repo: { type: 'string', description: 'Repository (owner/name).' },
    account: ACCOUNT_PROP.account,
  },
};

const READ_FILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['repo', 'path'],
  properties: {
    repo: { type: 'string', description: 'Repository (owner/name).' },
    path: { type: 'string', description: 'File path in the repo.' },
    ref: { type: 'string', description: 'Optional branch, tag, or commit SHA (default: default branch).' },
    account: ACCOUNT_PROP.account,
  },
};

const ISSUES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['repo'],
  properties: {
    repo: { type: 'string', description: 'Repository (owner/name).' },
    state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state (default: open).' },
    account: ACCOUNT_PROP.account,
  },
};

const CREATE_ISSUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['repo', 'title'],
  properties: {
    repo: { type: 'string', description: 'Repository (owner/name).' },
    title: { type: 'string', minLength: 1, description: 'Issue title.' },
    body: { type: 'string', description: 'Optional issue body.' },
    account: ACCOUNT_PROP.account,
  },
};

const PRS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['repo'],
  properties: {
    repo: { type: 'string', description: 'Repository (owner/name).' },
    state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'PR state (default: open).' },
    account: ACCOUNT_PROP.account,
  },
};

const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1, description: 'Code search query (e.g. "function name" or "TODO").' },
    repo: { type: 'string', description: 'Optional repository (owner/name) to scope search.' },
    account: ACCOUNT_PROP.account,
  },
};

// Resolve a GitHub client for the selected account: registry first (the PAT is the resolved token),
// then the legacy single GITHUB_TOKEN secret. Returns an error string when nothing usable resolves.
async function resolveClient(
  ctx: ToolContext,
  store: AccountStore | null,
  seal: SealFn | undefined,
  account: string | undefined,
): Promise<{ client?: GitHubClient; error?: string }> {
  if (store) {
    try {
      const { accessToken } = await resolveAccessToken(store, githubAdapter, ctx, {
        ...(account ? { accountSelector: account } : {}),
        ...(seal ? { seal } : {}),
      });
      return { client: new GitHubClient(accessToken) };
    } catch (exc) {
      if (exc instanceof AccountResolveError) return { error: exc.message };
      if (!(exc instanceof NotConnectedError)) {
        return { error: exc instanceof Error ? exc.message : 'failed to resolve GitHub account' };
      }
    }
  }
  const token = await secretOpt(ctx, 'GITHUB_TOKEN');
  if (token) {
    return { client: new GitHubClient(token) };
  }
  return {
    error:
      "GitHub isn't connected — add an account under Connections, or set the legacy GITHUB_TOKEN vault secret.",
  };
}

export function makeGitHubTools(store: AccountStore | null, seal?: SealFn): Tool[] {
  const githubReposTool: Tool = {
    name: 'github_repos',
    description:
      "List repos accessible to a connected GitHub account. Use `account` to pick which connected account. Returns repo name, privacy, description, default branch, URL, and last updated time.",
    inputSchema: REPOS_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { account?: string };
        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create GitHub client' };
          return;
        }
        const result = await client.listRepos();
        if (!result.ok) {
          yield { type: 'error', message: result.error ?? 'Failed to list repos' };
        } else {
          yield { type: 'result', value: { count: result.repos?.length ?? 0, repos: result.repos ?? [] } };
        }
      },
    },
  };

  const githubRepoTool: Tool = {
    name: 'github_repo',
    description: 'Get metadata for a specific GitHub repo. Use `account` to pick which connected account.',
    inputSchema: REPO_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { repo?: string; account?: string };
        const repo = String(args.repo ?? '').trim();
        if (!repo) {
          yield { type: 'error', message: 'repo is required' };
          return;
        }
        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create GitHub client' };
          return;
        }
        const result = await client.getRepo(repo);
        if (!result.ok) {
          yield { type: 'error', message: result.error ?? 'Failed to get repo' };
        } else {
          yield { type: 'result', value: result.repo };
        }
      },
    },
  };

  const githubReadFileTool: Tool = {
    name: 'github_read_file',
    description:
      'Read a file from a GitHub repo (text only, max ~256KB). Use `account` to pick which connected account. Returns the file text and HTML URL.',
    inputSchema: READ_FILE_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { repo?: string; path?: string; ref?: string; account?: string };
        const repo = String(args.repo ?? '').trim();
        const path = String(args.path ?? '').trim();
        if (!repo || !path) {
          yield { type: 'error', message: 'repo and path are required' };
          return;
        }
        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create GitHub client' };
          return;
        }
        const result = await client.readFile(repo, path, args.ref ? String(args.ref) : undefined);
        if (!result.ok) {
          yield { type: 'error', message: result.error ?? 'Failed to read file' };
        } else {
          yield { type: 'result', value: { content: result.content, html_url: result.html_url } };
        }
      },
    },
  };

  const githubListIssuesTool: Tool = {
    name: 'github_list_issues',
    description: 'List issues for a GitHub repo. Use `account` to pick which connected account. Returns issue number, title, state, URL, body, author, and created date.',
    inputSchema: ISSUES_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { repo?: string; state?: string; account?: string };
        const repo = String(args.repo ?? '').trim();
        if (!repo) {
          yield { type: 'error', message: 'repo is required' };
          return;
        }
        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create GitHub client' };
          return;
        }
        const result = await client.listIssues(repo, args.state ? String(args.state) : undefined);
        if (!result.ok) {
          yield { type: 'error', message: result.error ?? 'Failed to list issues' };
        } else {
          yield { type: 'result', value: { count: result.issues?.length ?? 0, issues: result.issues ?? [] } };
        }
      },
    },
  };

  const githubCreateIssueTool: Tool = {
    name: 'github_create_issue',
    description: 'Create an issue in a GitHub repo. Use `account` to pick which connected account. Returns the issue number and URL.',
    inputSchema: CREATE_ISSUE_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { repo?: string; title?: string; body?: string; account?: string };
        const repo = String(args.repo ?? '').trim();
        const title = String(args.title ?? '').trim();
        if (!repo || !title) {
          yield { type: 'error', message: 'repo and title are required' };
          return;
        }
        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create GitHub client' };
          return;
        }
        const result = await client.createIssue(repo, title, args.body ? String(args.body) : undefined);
        if (!result.ok) {
          yield { type: 'error', message: result.error ?? 'Failed to create issue' };
        } else {
          yield {
            type: 'result',
            value: { issue_number: result.issue?.number, html_url: result.issue?.html_url, message: 'Issue created' },
          };
        }
      },
    },
  };

  const githubListPRsTool: Tool = {
    name: 'github_list_prs',
    description: 'List pull requests for a GitHub repo. Use `account` to pick which connected account. Returns PR number, title, state, URL, body, author, and created date.',
    inputSchema: PRS_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { repo?: string; state?: string; account?: string };
        const repo = String(args.repo ?? '').trim();
        if (!repo) {
          yield { type: 'error', message: 'repo is required' };
          return;
        }
        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create GitHub client' };
          return;
        }
        const result = await client.listPRs(repo, args.state ? String(args.state) : undefined);
        if (!result.ok) {
          yield { type: 'error', message: result.error ?? 'Failed to list PRs' };
        } else {
          yield { type: 'result', value: { count: result.prs?.length ?? 0, prs: result.prs ?? [] } };
        }
      },
    },
  };

  const githubSearchCodeTool: Tool = {
    name: 'github_search_code',
    description:
      'Search code across accessible GitHub repos. Use `account` to pick which connected account. Optionally scope to a specific repo. Returns file name, path, repo, and URL for each match.',
    inputSchema: SEARCH_SCHEMA,
    executor: {
      async *execute(input: unknown, ctx: ToolContext) {
        const args = (input ?? {}) as { query?: string; repo?: string; account?: string };
        const query = String(args.query ?? '').trim();
        if (!query) {
          yield { type: 'error', message: 'query is required' };
          return;
        }
        const { client, error } = await resolveClient(ctx, store, seal, args.account);
        if (!client) {
          yield { type: 'error', message: error ?? 'Failed to create GitHub client' };
          return;
        }
        const result = await client.searchCode(query, args.repo ? String(args.repo) : undefined);
        if (!result.ok) {
          yield { type: 'error', message: result.error ?? 'Failed to search code' };
        } else {
          yield { type: 'result', value: { count: result.results?.length ?? 0, results: result.results ?? [] } };
        }
      },
    },
  };

  return [
    githubReposTool,
    githubRepoTool,
    githubReadFileTool,
    githubListIssuesTool,
    githubCreateIssueTool,
    githubListPRsTool,
    githubSearchCodeTool,
  ];
}
