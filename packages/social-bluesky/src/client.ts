// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { secretOpt, secretRequired } from './vault.js';
import type {
  CreateSessionResponse,
  RefreshSessionResponse,
  SessionState,
  JwtPayload,
  Facet,
  FacetIndex,
} from './types.js';

const DEFAULT_SERVICE = 'https://bsky.social';
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

export class BlueskyClient {
  private service: string;
  private ctx: ToolContext;

  constructor(
    ctx: ToolContext,
    service?: string
  ) {
    this.ctx = ctx;
    this.service = service || DEFAULT_SERVICE;
  }

  private decodeJwtExpiry(jwt: string): Date | null {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    try {
      const middle = parts[1];
      if (!middle) return null;
      const padded = middle.replace(/-/g, '+').replace(/_/g, '/');
      const b64 = padded + '='.repeat((4 - (padded.length % 4)) % 4);
      const json = Buffer.from(b64, 'base64').toString('utf-8');
      const payload = JSON.parse(json) as { exp?: number };
      if (typeof payload.exp !== 'number') return null;
      return new Date(payload.exp * 1000);
    } catch {
      return null;
    }
  }

  private async createSession(identifier: string, password: string): Promise<CreateSessionResponse> {
    const res = await fetch(`${this.service}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password }),
    });
    if (!res.ok) {
      throw new Error(`createSession failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as CreateSessionResponse;
  }

  private async refreshSession(refreshJwt: string): Promise<RefreshSessionResponse | null> {
    const res = await fetch(`${this.service}/xrpc/com.atproto.server.refreshSession`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${refreshJwt}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as RefreshSessionResponse;
  }

  async getValidAccessJwt(): Promise<SessionState | null> {
    const handle = await secretOpt(this.ctx, 'BLUESKY_HANDLE');
    const appPassword = await secretOpt(this.ctx, 'BLUESKY_APP_PASSWORD');

    if (!handle || !appPassword) {
      return null;
    }

    const accessJwtKey = 'BLUESKY_ACCESS_JWT';
    const refreshJwtKey = 'BLUESKY_REFRESH_JWT';
    const expiryKey = 'BLUESKY_ACCESS_JWT_EXPIRY';
    const didKey = 'BLUESKY_DID';

    // Fast path: cached access JWT not yet near expiry
    const expiryStr = await secretOpt(this.ctx, expiryKey);
    const accessJwt = await secretOpt(this.ctx, accessJwtKey);
    const did = await secretOpt(this.ctx, didKey);

    if (accessJwt && expiryStr && did) {
      const expMs = new Date(expiryStr).getTime();
      if (expMs - Date.now() > REFRESH_WINDOW_MS) {
        return { accessJwt, did, service: this.service };
      }
    }

    // Try refresh
    const refreshJwt = await secretOpt(this.ctx, refreshJwtKey);
    if (refreshJwt) {
      const refreshed = await this.refreshSession(refreshJwt);
      if (refreshed) {
        const accessExp = this.decodeJwtExpiry(refreshed.accessJwt);
        if (accessExp) {
          await this.ctx.vault.writeSecret(accessJwtKey, refreshed.accessJwt);
          await this.ctx.vault.writeSecret(refreshJwtKey, refreshed.refreshJwt);
          await this.ctx.vault.writeSecret(expiryKey, accessExp.toISOString());
          await this.ctx.vault.writeSecret(didKey, refreshed.did);
        }
        return {
          accessJwt: refreshed.accessJwt,
          did: refreshed.did,
          service: this.service,
        };
      }
    }

    // Last resort: re-mint from app password
    try {
      const session = await this.createSession(handle, appPassword);
      const accessExp = this.decodeJwtExpiry(session.accessJwt);
      if (accessExp) {
        await this.ctx.vault.writeSecret(accessJwtKey, session.accessJwt);
        await this.ctx.vault.writeSecret(refreshJwtKey, session.refreshJwt);
        await this.ctx.vault.writeSecret(expiryKey, accessExp.toISOString());
        await this.ctx.vault.writeSecret(didKey, session.did);
      }
      return {
        accessJwt: session.accessJwt,
        did: session.did,
        service: this.service,
      };
    } catch {
      return null;
    }
  }

  private detectFacets(text: string): Facet[] {
    const utf8 = Buffer.from(text, 'utf-8');
    const facets: Facet[] = [];

    interface CodePoint {
      byteOffset: number;
      charLen: number;
    }
    const codePoints: CodePoint[] = [];
    let byteOffset = 0;
    for (const ch of text) {
      Buffer.byteLength(ch, 'utf-8');
      codePoints.push({ byteOffset, charLen: ch.length });
      byteOffset += Buffer.byteLength(ch, 'utf-8');
    }

    function charIndexToByte(i: number): number {
      let acc = 0;
      for (const cp of codePoints) {
        if (acc >= i) return cp.byteOffset;
        if (acc + cp.charLen > i) return cp.byteOffset;
        acc += cp.charLen;
      }
      return utf8.length;
    }

    const URL_REGEX = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)]/g;
    const TAG_REGEX = /(^|\s)(#[A-Za-z_][A-Za-z0-9_]*)/g;

    let m: RegExpExecArray | null;
    URL_REGEX.lastIndex = 0;
    while ((m = URL_REGEX.exec(text)) !== null) {
      const start = charIndexToByte(m.index);
      const end = charIndexToByte(m.index + m[0].length);
      facets.push({
        index: { byteStart: start, byteEnd: end },
        features: [{ $type: 'app.bsky.richtext.facet#link', uri: m[0] }],
      });
    }

    TAG_REGEX.lastIndex = 0;
    while ((m = TAG_REGEX.exec(text)) !== null) {
      const tagWithHash = m[2] ?? '';
      const charStart = m.index + (m[1]?.length ?? 0);
      const start = charIndexToByte(charStart);
      const end = charIndexToByte(charStart + tagWithHash.length);
      facets.push({
        index: { byteStart: start, byteEnd: end },
        features: [{ $type: 'app.bsky.richtext.facet#tag', tag: tagWithHash.slice(1) }],
      });
    }
    return facets;
  }

  private graphemeCount(text: string): number {
    if (typeof Intl !== 'undefined' && typeof (Intl as any).Segmenter === 'function') {
      const seg = new (Intl as any).Segmenter('en', { granularity: 'grapheme' });
      return Array.from(seg.segment(text)).length;
    }
    return Array.from(text).length;
  }

  async post(text: string, replyTo?: string): Promise<{ uri: string; cid: string; error?: string }> {
    const session = await this.getValidAccessJwt();
    if (!session) {
      return {
        uri: '',
        cid: '',
        error:
          "Bluesky isn't connected — set BLUESKY_HANDLE and BLUESKY_APP_PASSWORD in vault/env (Settings → Connections)",
      };
    }

    if (this.graphemeCount(text) > 300) {
      return { uri: '', cid: '', error: 'Post exceeds 300 character limit' };
    }

    try {
      const facets = this.detectFacets(text);

      let reply: Record<string, unknown> | undefined;
      if (replyTo) {
        const parentRef = await this.fetchPostRef(session.accessJwt, replyTo);
        if (!parentRef) {
          return { uri: '', cid: '', error: `Reply parent not found: ${replyTo}` };
        }
        reply = { parent: parentRef, root: parentRef };
      }

      const record: Record<string, unknown> = {
        $type: 'app.bsky.feed.post',
        text,
        createdAt: new Date().toISOString(),
        ...(facets.length > 0 ? { facets } : {}),
        ...(reply ? { reply } : {}),
      };

      const res = await fetch(`${session.service}/xrpc/com.atproto.repo.createRecord`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.accessJwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          repo: session.did,
          collection: 'app.bsky.feed.post',
          record,
        }),
      });

      if (!res.ok) {
        return { uri: '', cid: '', error: `createRecord failed: ${res.status} ${await res.text()}` };
      }

      const data = (await res.json()) as { uri: string; cid: string };
      return { uri: data.uri, cid: data.cid };
    } catch {
      return {
        uri: '',
        cid: '',
        error: 'Failed to post to Bluesky',
      };
    }
  }

  async readFeed(limit: number = 20): Promise<{ posts: Array<any>; error?: string }> {
    const session = await this.getValidAccessJwt();
    if (!session) {
      return {
        posts: [],
        error:
          "Bluesky isn't connected — set BLUESKY_HANDLE and BLUESKY_APP_PASSWORD in vault/env (Settings → Connections)",
      };
    }

    try {
      const url = new URL(`${session.service}/xrpc/app.bsky.feed.getAuthorFeed`);
      url.searchParams.set('actor', session.did);
      url.searchParams.set('limit', String(Math.min(limit, 100)));

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${session.accessJwt}` },
      });

      if (!res.ok) {
        return { posts: [], error: `Feed fetch failed: ${res.status}` };
      }

      const data = (await res.json()) as { feed?: Array<{ post: any }> };
      return { posts: data.feed?.map((item) => item.post) ?? [] };
    } catch {
      return {
        posts: [],
        error: 'Failed to read feed from Bluesky',
      };
    }
  }

  async search(query: string, limit: number = 20): Promise<{ posts: Array<any>; error?: string }> {
    const session = await this.getValidAccessJwt();
    if (!session) {
      return {
        posts: [],
        error:
          "Bluesky isn't connected — set BLUESKY_HANDLE and BLUESKY_APP_PASSWORD in vault/env (Settings → Connections)",
      };
    }

    try {
      const url = new URL(`${session.service}/xrpc/app.bsky.feed.searchPosts`);
      url.searchParams.set('q', query);
      url.searchParams.set('limit', String(Math.min(limit, 100)));

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${session.accessJwt}` },
      });

      if (!res.ok) {
        return { posts: [], error: `Search failed: ${res.status}` };
      }

      const data = (await res.json()) as { posts?: Array<any> };
      return { posts: data.posts ?? [] };
    } catch {
      return {
        posts: [],
        error: 'Failed to search Bluesky',
      };
    }
  }

  private async fetchPostRef(
    accessJwt: string,
    uri: string
  ): Promise<{ uri: string; cid: string } | null> {
    const url = new URL(`${this.service}/xrpc/app.bsky.feed.getPosts`);
    url.searchParams.set('uris', uri);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessJwt}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { posts?: Array<{ uri: string; cid: string }> };
    const post = data.posts?.[0];
    return post ? { uri: post.uri, cid: post.cid } : null;
  }
}
