// SPDX-License-Identifier: AGPL-3.0-or-later
// Provider adapter registry — the single source of truth for which (kind, provider) pairs Charles
// can attach as venture resources (Track V1, charles ventures_resource_cleanup).
//
// charles_provider_abstraction applied to the attach flow: a provider is 'available' ONLY when a
// working adapter backs it ("no adapter -> not offered"). Everything else is 'planned' — known and
// roadmapped, but NOT attachable until its adapter ships. The attach tool (tools.ts
// venture_attach_resource) offers/validates AVAILABLE providers only; the DB CHECK in
// sql/0004_venture_resource_provider.sql is a wider backstop over the whole known universe, so
// promoting a provider planned -> available is a one-line code change here, no migration.
//
// Reality today: the only live adapter is `manual` (the always-on local-store fallback the doctrine
// mandates first) — the operator records the handle/id by hand; there is no live integration. Every
// vendor/platform is `planned` until its adapter ships.

export const RESOURCE_KINDS = ['social_account', 'mailing_list', 'analytics_property'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export type ProviderStatus = 'available' | 'planned';

/** Outcome of normalising/validating a user-supplied external_ref for a provider (Track V2). */
export interface ResolvedRef {
  ok: boolean;
  /** The canonical external_ref to persist (set when ok). */
  value?: string;
  /** Why the ref was rejected (set when !ok). */
  error?: string;
}

export interface ProviderAdapter {
  kind: ResourceKind;
  provider: string;
  label: string;
  status: ProviderStatus;
  /**
   * Track V2: normalise/validate the operator-supplied external_ref into a canonical form, instead
   * of persisting a free string. Available adapters implement it; absent => the ref is accepted
   * trimmed (no resolution). Wired in tools.ts before the row is stored.
   */
  resolveRef?: (ref: string) => ResolvedRef;
}

// Track V2 — external_ref resolution. For the `manual` adapters there is no live API to validate
// against, so "resolve" = normalise the operator's typed value into a canonical form (and reject
// structurally-broken input) instead of persisting a free string. A bare social handle has its
// leading '@' stripped and must be whitespace-free (it is a handle or a profile URL); list /
// property names are free-form but trimmed and non-empty. When a live adapter (ga4, mailchimp, …)
// ships it supplies its own resolveRef that checks the ref against the provider / a connected account.
function resolveManualHandle(ref: string): ResolvedRef {
  let v = ref.trim();
  if (!v) return { ok: false, error: 'a social handle or profile URL is required' };
  if (!/^https?:\/\//i.test(v)) v = v.replace(/^@+/, ''); // bare handle: drop a leading '@'
  if (!v) return { ok: false, error: 'a social handle or profile URL is required' };
  if (/\s/.test(v)) return { ok: false, error: 'a social handle/URL must not contain spaces' };
  return { ok: true, value: v };
}

function resolveManualName(ref: string): ResolvedRef {
  const v = ref.trim();
  if (!v) return { ok: false, error: 'a name or id is required' };
  return { ok: true, value: v };
}

// The known universe of providers per kind. `manual` is available for every kind; the rest are the
// roadmapped vendors/platforms, planned until their adapter ships. Keep the provider names in step
// with the vr_provider_chk CHECK in sql/0004_venture_resource_provider.sql (the DB backstop).
export const REGISTRY: ProviderAdapter[] = [
  // social_account — publish-self platforms. The eidan social-* plugins now ship live OAuth/account
  // connections, so these are AVAILABLE: external_ref is the public handle (normalised here), and the
  // attach tool additionally checks it against the live connection registry (the SocialConnections
  // service) when that plugin is loaded. `manual` stays available as the doctrine-mandated fallback.
  { kind: 'social_account', provider: 'manual', label: 'Manual (operator-tracked)', status: 'available', resolveRef: resolveManualHandle },
  { kind: 'social_account', provider: 'x', label: 'X / Twitter', status: 'available', resolveRef: resolveManualHandle },
  { kind: 'social_account', provider: 'linkedin', label: 'LinkedIn', status: 'available', resolveRef: resolveManualHandle },
  { kind: 'social_account', provider: 'instagram', label: 'Instagram', status: 'available', resolveRef: resolveManualHandle },
  { kind: 'social_account', provider: 'facebook', label: 'Facebook', status: 'available', resolveRef: resolveManualHandle },
  { kind: 'social_account', provider: 'threads', label: 'Threads', status: 'available', resolveRef: resolveManualHandle },
  { kind: 'social_account', provider: 'bluesky', label: 'Bluesky', status: 'available', resolveRef: resolveManualHandle },
  { kind: 'social_account', provider: 'mastodon', label: 'Mastodon', status: 'available', resolveRef: resolveManualHandle },
  { kind: 'social_account', provider: 'tiktok', label: 'TikTok', status: 'planned' },
  { kind: 'social_account', provider: 'youtube', label: 'YouTube', status: 'available', resolveRef: resolveManualHandle },
  // mailing_list — audience backends (a future `social`/mailing adapter).
  { kind: 'mailing_list', provider: 'manual', label: 'Manual (operator-tracked)', status: 'available', resolveRef: resolveManualName },
  { kind: 'mailing_list', provider: 'mailchimp', label: 'Mailchimp', status: 'planned' },
  { kind: 'mailing_list', provider: 'ses', label: 'Amazon SES', status: 'planned' },
  // analytics_property — metrics backends (a future `analytics` adapter).
  { kind: 'analytics_property', provider: 'manual', label: 'Manual (operator-tracked)', status: 'available', resolveRef: resolveManualName },
  { kind: 'analytics_property', provider: 'ga4', label: 'Google Analytics 4', status: 'planned' },
  { kind: 'analytics_property', provider: 'vercel', label: 'Vercel Analytics', status: 'planned' },
  { kind: 'analytics_property', provider: 'plausible', label: 'Plausible', status: 'planned' },
];

export function isResourceKind(kind: string): kind is ResourceKind {
  return (RESOURCE_KINDS as readonly string[]).includes(kind);
}

export function getAdapter(kind: string, provider: string): ProviderAdapter | undefined {
  return REGISTRY.find((a) => a.kind === kind && a.provider === provider);
}

export function isAvailable(kind: string, provider: string): boolean {
  return getAdapter(kind, provider)?.status === 'available';
}

function byKind(predicate: (a: ProviderAdapter) => boolean): Record<ResourceKind, string[]> {
  const out = Object.fromEntries(RESOURCE_KINDS.map((k) => [k, [] as string[]])) as Record<ResourceKind, string[]>;
  for (const a of REGISTRY) if (predicate(a)) out[a.kind].push(a.provider);
  return out;
}

/** Attachable providers per kind (adapter-backed). The attach flow offers/validates these only. */
export function availableProvidersByKind(): Record<ResourceKind, string[]> {
  return byKind((a) => a.status === 'available');
}

/** Roadmapped-but-not-yet-attachable providers per kind (for honest "not supported yet" messaging). */
export function plannedProvidersByKind(): Record<ResourceKind, string[]> {
  return byKind((a) => a.status === 'planned');
}

/** The flat set of attachable provider names (for a JSON-schema enum). */
export function availableProviders(): string[] {
  return [...new Set(REGISTRY.filter((a) => a.status === 'available').map((a) => a.provider))];
}
