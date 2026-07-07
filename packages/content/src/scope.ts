// SPDX-License-Identifier: AGPL-3.0-or-later
// Brand-kit scoping + cascade. A brand kit is addressed by a `scope` string, and scopes form a
// hierarchy that mirrors the venture tree plus an optional channel leaf:
//
//   default                       ← house style (fallback for everything)
//   venture:<id>                  ← a venture's brand (e.g. SIELAY Ltd = B2B, serious)
//   venture:<id>:<channel>        ← a channel sub-brand within that venture (e.g. instagram = lighter)
//
// Generation resolves the EFFECTIVE brand by layering, most-general first: default → each ancestor
// venture (root→…→leaf) → the target venture → the channel leaf. Later layers override earlier ones
// field-by-field, so you set a venture's brand once and only override the *deltas* per channel. This
// module is pure (no db, no matbot) so the cascade is unit-testable in isolation.

// The channels a sub-brand may target. Mirrors the social providers + the owned surfaces
// (newsletter/blog). UI-facing allow-list; the backend stores whatever string it's given.
export const CHANNELS = [
  'linkedin', 'instagram', 'x', 'threads', 'tiktok', 'youtube', 'mastodon', 'bluesky',
  'newsletter', 'blog',
] as const;
export type Channel = (typeof CHANNELS)[number];

export function isChannel(v: string): v is Channel {
  return (CHANNELS as readonly string[]).includes(v);
}

export const DEFAULT_SCOPE = 'default';

export function ventureScope(ventureId: string): string {
  return `venture:${ventureId}`;
}

export function channelScope(ventureId: string, channel: string): string {
  return `venture:${ventureId}:${channel}`;
}

export interface ScopeParts {
  kind: 'default' | 'venture' | 'channel';
  ventureId?: string;
  channel?: string;
}

// Parse a scope string back to its parts. Unknown shapes fall back to 'default' so a malformed scope
// can never widen access — it just reads the house style.
export function parseScope(scope: string): ScopeParts {
  const s = (scope || '').trim();
  if (!s || s === DEFAULT_SCOPE) return { kind: 'default' };
  const m = /^venture:([^:]+)(?::(.+))?$/.exec(s);
  if (!m) return { kind: 'default' };
  const ventureId = m[1];
  if (!ventureId) return { kind: 'default' };
  const channel = m[2];
  if (channel) return { kind: 'channel', ventureId, channel };
  return { kind: 'venture', ventureId };
}

// Build the ordered list of scopes to layer for a target scope, given the venture ancestry
// (root-first venture ids, ending with the target venture). `default` is always first (most general);
// the channel leaf, if any, is last (most specific). Ancestry lets a child venture inherit its
// parent's brand — SIELAY Ltd → Adaptive Mindset → :instagram.
export function scopeChain(target: string, ancestry: readonly string[]): string[] {
  const parts = parseScope(target);
  const chain: string[] = [DEFAULT_SCOPE];
  if (parts.kind === 'default') return chain;
  // ancestry is root→…→target venture; if the caller couldn't resolve it, fall back to the lone id.
  const line = ancestry.length ? ancestry : (parts.ventureId ? [parts.ventureId] : []);
  for (const id of line) chain.push(ventureScope(id));
  if (parts.kind === 'channel' && parts.ventureId && parts.channel) {
    chain.push(channelScope(parts.ventureId, parts.channel));
  }
  return dedupe(chain);
}

// The fields that cascade. Kept structural (not the db BrandKit) so this module stays pure.
export interface BrandAsset { id: string; role: string }
export interface BrandFields {
  voice: string | null;
  styleguide: string | null;
  language: string | null;
  reference_images: string[];
  brand_assets: BrandAsset[];
}

function nonEmpty(v: string | null | undefined): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

// Merge brand layers in cascade order (most-general first). For each text field the last layer that
// sets a non-empty value wins; reference_images and brand_assets accumulate (union, order-preserving)
// so a channel adds to — rather than replaces — the venture's assets. Absent layers are simply skipped.
export function mergeBrandLayers(layers: readonly Partial<BrandFields>[]): BrandFields {
  const out: BrandFields = { voice: null, styleguide: null, language: null, reference_images: [], brand_assets: [] };
  const refs: string[] = [];
  const assets: BrandAsset[] = [];
  for (const layer of layers) {
    if (!layer) continue;
    const v = nonEmpty(layer.voice); if (v) out.voice = v;
    const s = nonEmpty(layer.styleguide); if (s) out.styleguide = s;
    const l = nonEmpty(layer.language); if (l) out.language = l;
    for (const r of layer.reference_images ?? []) if (r && !refs.includes(r)) refs.push(r);
    for (const a of layer.brand_assets ?? []) if (a.id && !assets.some((x) => x.id === a.id)) assets.push(a);
  }
  out.reference_images = refs;
  out.brand_assets = assets;
  return out;
}

function dedupe(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) if (!seen.has(x)) { seen.add(x); out.push(x); }
  return out;
}
