// SPDX-License-Identifier: AGPL-3.0-or-later
// Bluesky (AT Protocol) client. Stateless across the vault: the constructor takes a handle + app
// password (+ optional service host) — supplied by the resolver from a connected account, or by the
// legacy single-secret fallback. Each call mints a fresh session JWT from the app password via
// com.atproto.server.createSession, then posts/searches/reads the feed.
import type { Facet, CreateSessionResponse, SessionState } from './types.js';

const DEFAULT_SERVICE = 'https://bsky.social';

export class BlueskyClient {
  private handle: string;
  private appPassword: string;
  private service: string;
  private session: SessionState | null;

  constructor(handle: string, appPassword: string, service?: string) {
    this.handle = handle;
    this.appPassword = appPassword;
    this.service = service || DEFAULT_SERVICE;
    this.session = null;
  }

  private async createSession(): Promise<SessionState | null> {
    if (this.session) return this.session;
    if (!this.handle || !this.appPassword) return null;
    try {
      const res = await fetch(`${this.service}/xrpc/com.atproto.server.createSession`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: this.handle, password: this.appPassword }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as CreateSessionResponse;
      this.session = { accessJwt: data.accessJwt, did: data.did, service: this.service };
      return this.session;
    } catch {
      return null;
    }
  }

  // Public connection probe: mint a session with the stored handle + app password. Returns the DID
  // on success, or an error reason. Used by the Connections "Test" button (via the adapter).
  async verify(): Promise<{ ok: boolean; did?: string; error?: string }> {
    if (!this.handle || !this.appPassword) return { ok: false, error: 'handle and app password are required' };
    const session = await this.createSession();
    if (!session) return { ok: false, error: 'sign-in failed — check the handle, app password and service URL' };
    return { ok: true, did: session.did };
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
    if (typeof Intl !== 'undefined' && typeof (Intl as { Segmenter?: unknown }).Segmenter === 'function') {
      const seg = new (Intl as unknown as { Segmenter: new (l: string, o: { granularity: string }) => { segment(t: string): Iterable<unknown> } }).Segmenter(
        'en',
        { granularity: 'grapheme' },
      );
      return Array.from(seg.segment(text)).length;
    }
    return Array.from(text).length;
  }

  async post(text: string, replyTo?: string): Promise<{ uri: string; cid: string; error?: string }> {
    const session = await this.createSession();
    if (!session) {
      return { uri: '', cid: '', error: 'Bluesky session could not be created — check the handle and app password.' };
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
      return { uri: '', cid: '', error: 'Failed to post to Bluesky' };
    }
  }

  async readFeed(limit: number = 20): Promise<{ posts: Array<Record<string, unknown>>; error?: string }> {
    const session = await this.createSession();
    if (!session) {
      return { posts: [], error: 'Bluesky session could not be created — check the handle and app password.' };
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

      const data = (await res.json()) as { feed?: Array<{ post: Record<string, unknown> }> };
      return { posts: data.feed?.map((item) => item.post) ?? [] };
    } catch {
      return { posts: [], error: 'Failed to read feed from Bluesky' };
    }
  }

  async search(query: string, limit: number = 20): Promise<{ posts: Array<Record<string, unknown>>; error?: string }> {
    const session = await this.createSession();
    if (!session) {
      return { posts: [], error: 'Bluesky session could not be created — check the handle and app password.' };
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

      const data = (await res.json()) as { posts?: Array<Record<string, unknown>> };
      return { posts: data.posts ?? [] };
    } catch {
      return { posts: [], error: 'Failed to search Bluesky' };
    }
  }

  private async fetchPostRef(accessJwt: string, uri: string): Promise<{ uri: string; cid: string } | null> {
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
