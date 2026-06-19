// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent tools for the `google` plugin — read the operator's Gmail.
//
// Per-account OAuth: the operator connects one or more Gmail accounts in the Connections screen. Each
// account's OAuth client id/secret (sealed as JSON under `client_vault_key`) and refresh token (sealed
// under `refresh_vault_key`) live in the vault; the registry rows live in plugin_google.accounts. At
// call time the tools resolve the first connected account, mint a short-lived access token from its
// refresh token, then call the Gmail API. Falls back to the legacy single EIDAN_GOOGLE_* env/secret
// keys when no account is registered, so older setups keep working. Read-only; nothing stored.
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import { GmailClient } from './gmail.js';
import { OAuthError, refreshAccessToken } from './oauth.js';
import { secretOpt } from './vault.js';
import type { Db } from './db.js';

const LIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max messages (default 20).' },
    query: { type: 'string', description: "Gmail search query, e.g. 'from:alice is:unread'." },
  },
};
const READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['message_id'],
  properties: {
    message_id: { type: 'string', minLength: 1, description: 'Gmail message id from gmail_list_recent.' },
  },
};

export interface OAuthCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

// Parse the JSON-packed client id/secret sealed under an account's client_vault_key.
function parseClient(raw: string): { clientId: string; clientSecret: string } | null {
  try {
    const j = JSON.parse(raw) as { client_id?: string; client_secret?: string };
    if (j.client_id && j.client_secret) return { clientId: j.client_id, clientSecret: j.client_secret };
  } catch {
    // not JSON
  }
  return null;
}

// Resolve the first connected account's vaulted client + refresh token from the registry, or null
// when none resolves. No legacy fallback, no throw — this is the shape exposed to other plugins
// (e.g. gdrive) as the GoogleConnection service so a single connected account serves them all.
export async function resolveFromRegistry(db: Db, ctx: ToolContext): Promise<OAuthCreds | null> {
  for (const row of await db.listAccounts()) {
    try {
      const clientRaw = await ctx.vault.resolve('${' + row.client_vault_key + '}');
      const refreshToken = await ctx.vault.resolve('${' + row.refresh_vault_key + '}');
      const client = parseClient(String(clientRaw ?? ''));
      if (client && refreshToken && refreshToken.trim()) {
        return { ...client, refreshToken: refreshToken.trim() };
      }
    } catch {
      // An account whose secret was removed out-of-band — try the next rather than fail the call.
    }
  }
  return null;
}

// Resolve the caller's OAuth credentials: the first connected account's vaulted client + refresh
// token, else the legacy single EIDAN_GOOGLE_* keys. Mirrors ical's resolveCalendars fallback.
async function resolveCreds(db: Db, ctx: ToolContext): Promise<OAuthCreds> {
  const fromRegistry = await resolveFromRegistry(db, ctx);
  if (fromRegistry) return fromRegistry;
  const clientId = await secretOpt(ctx, 'EIDAN_GOOGLE_CLIENT_ID');
  const clientSecret = await secretOpt(ctx, 'EIDAN_GOOGLE_CLIENT_SECRET');
  const refreshToken = await secretOpt(ctx, 'EIDAN_GOOGLE_REFRESH_TOKEN');
  if (clientId && clientSecret && refreshToken) {
    return { clientId, clientSecret, refreshToken };
  }
  throw new OAuthError(
    "Google isn't connected — add a Gmail account under Connections (or set EIDAN_GOOGLE_CLIENT_ID, " +
      'EIDAN_GOOGLE_CLIENT_SECRET and EIDAN_GOOGLE_REFRESH_TOKEN).',
  );
}

async function accessToken(db: Db, ctx: ToolContext): Promise<string> {
  const creds = await resolveCreds(db, ctx);
  try {
    return await refreshAccessToken(creds);
  } catch (exc) {
    throw new OAuthError(`Google token refresh failed: ${exc instanceof Error ? exc.message : String(exc)}`);
  }
}

export function makeGmailTools(db: Db): Tool[] {
  const gmailListRecentTool: Tool = {
    name: 'gmail_list_recent',
    description:
      'List recent Gmail messages (id, from, subject, date, snippet), optionally filtered by a ' +
      "Gmail search query. Use to see the operator's mail before reading.",
    inputSchema: LIST_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { limit?: number; query?: string };
        const client = new GmailClient(await accessToken(db, ctx));
        const query = args.query ? String(args.query).trim() : '';
        const msgs = await client.listRecent(Number(args.limit) || 20, query || undefined);
        yield { type: 'result', value: { messages: msgs } };
      },
    },
  };

  const gmailReadTool: Tool = {
    name: 'gmail_read',
    description: 'Read one Gmail message in full (headers + plain-text body) by id.',
    inputSchema: READ_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { message_id?: string };
        const messageId = String(args.message_id ?? '').trim();
        if (!messageId) {
          yield { type: 'error', message: 'message_id is required' };
          return;
        }
        const msg = await new GmailClient(await accessToken(db, ctx)).read(messageId);
        yield {
          type: 'result',
          value: {
            id: msg.id,
            from: msg.from,
            to: msg.to,
            subject: msg.subject,
            date: msg.date,
            body: msg.body.slice(0, 8000),
          },
        };
      },
    },
  };

  return [gmailListRecentTool, gmailReadTool];
}
