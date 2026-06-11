// SPDX-License-Identifier: AGPL-3.0-or-later
// Plain CRUD read surface the Next app uses alongside the AG-UI turn stream: conversation list,
// a single conversation, its message history, title edit/regenerate. Reads eidan.* directly
// (RLS-scoped via the ambient principal + an explicit user_id filter). Runs under runAs(principal).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MatbotServices, Principal, Session, MessageContent } from '@matatbread/matbot-plugin-api';
import { withPrincipal } from './db.js';

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v ?? '');
}

function json(res: ServerResponse, code: number, obj: unknown, cors: Record<string, string>): void {
  res.writeHead(code, { 'content-type': 'application/json', ...cors });
  res.end(JSON.stringify(obj));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// matbot MessageContent[] -> the UI's flat {content, tool_calls, tool_results}.
function mapBlocks(blocks: MessageContent[] | null): {
  content: string | null;
  tool_calls: { id: string; name: string; input: Record<string, unknown> }[];
  tool_results: { tool_use_id: string; content: string; is_error: boolean }[];
} {
  let content = '';
  const tool_calls: { id: string; name: string; input: Record<string, unknown> }[] = [];
  const tool_results: { tool_use_id: string; content: string; is_error: boolean }[] = [];
  for (const b of blocks ?? []) {
    if (b.type === 'text' || b.type === 'refusal') content += b.text;
    else if (b.type === 'tool-call') tool_calls.push({ id: b.id, name: b.name, input: (b.input as Record<string, unknown>) ?? {} });
    else if (b.type === 'tool-result') {
      tool_results.push({ tool_use_id: b.id, content: typeof b.result === 'string' ? b.result : JSON.stringify(b.result), is_error: b.isError === true });
    }
  }
  return { content: content === '' ? null : content, tool_calls, tool_results };
}

function newSession(id: string, ownerId: string): Session {
  const now = new Date().toISOString();
  return { id, version: '0', ownerPrincipalId: ownerId, status: 'active', contexts: [], messages: [], createdAt: now, updatedAt: now };
}

// Returns true if it owned the route. `parts` is the path split on '/', e.g. ['api','conversations','<id>','messages'].
export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  services: MatbotServices,
  principal: Principal,
  cors: Record<string, string>,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const uid = principal.id;

  // /api/conversations
  if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'conversations') {
    if (method === 'GET') {
      const r = await withPrincipal(principal, (q) =>
        q('select id, title, created_at, updated_at from eidan.conversations where user_id=$1 and deleted_at is null order by coalesce(updated_at, created_at) desc limit 200', [uid]),
      );
      json(res, 200, { conversations: r.rows.map((row) => ({ id: row.id, title: row.title ?? null, created_at: iso(row.created_at), updated_at: iso(row.updated_at) })) }, cors);
      return true;
    }
    if (method === 'POST') {
      let title: string | null = null;
      try { const b = JSON.parse(await readBody(req)) as { title?: string | null }; title = b.title ?? null; } catch { /* empty body ok */ }
      const id = crypto.randomUUID();
      const sessions = services.sessions;
      if (!sessions) { json(res, 500, { error: 'sessions unavailable' }, cors); return true; }
      await sessions.set(id, newSession(id, uid));
      if (title) await withPrincipal(principal, (q) => q('update eidan.conversations set title=$2, updated_at=now() where id=$1 and user_id=$3', [id, title, uid]));
      json(res, 201, { id, title }, cors);
      return true;
    }
  }

  // /api/conversations/:id  and  /api/conversations/:id/(messages|regenerate_title)
  if (parts.length >= 3 && parts[0] === 'api' && parts[1] === 'conversations') {
    const id = parts[2] ?? '';
    const sub = parts[3];

    if (sub === undefined && method === 'GET') {
      const r = await withPrincipal(principal, (q) => q('select id, title, created_at, updated_at from eidan.conversations where id=$1 and user_id=$2 and deleted_at is null', [id, uid]));
      const row = r.rows[0];
      if (!row) { json(res, 404, { error: 'not found' }, cors); return true; }
      json(res, 200, { id: row.id, title: row.title ?? null, created_at: iso(row.created_at), updated_at: iso(row.updated_at) }, cors);
      return true;
    }

    if (sub === undefined && method === 'PATCH') {
      let title: string | null = null;
      try { const b = JSON.parse(await readBody(req)) as { title?: string | null }; title = (b.title ?? '').toString().trim() || null; } catch { /* */ }
      await withPrincipal(principal, (q) => q('update eidan.conversations set title=$2, updated_at=now() where id=$1 and user_id=$3', [id, title, uid]));
      json(res, 200, { id, title }, cors);
      return true;
    }

    if (sub === 'messages' && method === 'GET') {
      const r = await withPrincipal(principal, (q) =>
        q("select id, role, content_blocks, parent_message_id, provider, model, metadata, created_at from eidan.messages where conversation_id=$1 and user_id=$2 and role <> 'marker' and deleted_at is null order by seq asc", [id, uid]),
      );
      const messages = r.rows.map((row) => {
        const m = mapBlocks((row.content_blocks as MessageContent[] | null) ?? null);
        return {
          id: row.id, role: row.role, content: m.content, tool_calls: m.tool_calls, tool_results: m.tool_results,
          parent_message_id: row.parent_message_id ?? null, provider: row.provider ?? null, model: row.model ?? null,
          metadata: (row.metadata as Record<string, unknown> | null) ?? null, created_at: iso(row.created_at),
        };
      });
      json(res, 200, { messages }, cors);
      return true;
    }

    if (sub === 'regenerate_title' && method === 'POST') {
      const title = await withPrincipal(principal, async (q) => {
        const r = await q("select content_blocks from eidan.messages where conversation_id=$1 and user_id=$2 and role='user' and deleted_at is null order by seq asc limit 1", [id, uid]);
        const blocks = (r.rows[0]?.content_blocks as MessageContent[] | null) ?? null;
        const text = mapBlocks(blocks).content ?? 'New conversation';
        const t = text.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New conversation';
        await q('update eidan.conversations set title=$2, updated_at=now() where id=$1 and user_id=$3', [id, t, uid]);
        return t;
      });
      json(res, 200, { id, title }, cors);
      return true;
    }
  }

  return false;
}
