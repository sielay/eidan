// SPDX-License-Identifier: AGPL-3.0-or-later
// Data access for plugin_ventures.* (charles#12/#14/#16). Pure SQL over a `Q` query
// function (see db.ts) — no matbot import here, so the logic is unit-testable against a fake
// query fn. Every statement is user_id-scoped: the registry is the operator's, and explicit
// scoping keeps it correct independent of RLS on the plugin schema.
import type { Q } from './db.js';

const SLUG_RE = /[^a-z0-9]+/g;

// Columns returned to callers — one place so the row shape is stable.
const COLS = 'id, user_id, parent_id, name, slug, kind, legal_type, status, metadata, created_at, updated_at';
const RES_COLS = 'id, venture_id, user_id, kind, provider, external_ref, label, status, metadata, created_at, updated_at';
const ITEM_COLS = 'id, venture_id, user_id, kind, title, body, status, metadata, created_at, updated_at';

export interface VentureRow {
  id: string;
  user_id: string;
  parent_id: string | null;
  name: string;
  slug: string;
  kind: string;
  legal_type: string | null;
  status: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface ResourceRow {
  id: string;
  venture_id: string;
  user_id: string;
  kind: string;
  provider: string;
  external_ref: string;
  label: string | null;
  status: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface ItemRow {
  id: string;
  venture_id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string | null;
  status: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

/** A url-ish slug from a venture name (lowercase, hyphenated). */
export function slugify(name: string): string {
  const slug = name.trim().toLowerCase().replace(SLUG_RE, '-').replace(/^-+|-+$/g, '');
  return slug.slice(0, 60) || 'venture';
}

export interface CreateVentureArgs {
  userId: string;
  name: string;
  kind?: string;
  legalType?: string | null;
  parentId?: string | null;
  slug?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Insert a venture (a node in the tree) and return the row. `parentId` null makes it a top-level
 * org/venture. `slug` defaults to a slugified name; the per-owner active-slug unique index rejects
 * a duplicate.
 */
export async function createVenture(q: Q, args: CreateVentureArgs): Promise<VentureRow | null> {
  const r = await q(
    `INSERT INTO plugin_ventures.ventures
        (user_id, parent_id, name, slug, kind, legal_type, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING ${COLS}`,
    [
      args.userId,
      args.parentId ?? null,
      args.name,
      args.slug || slugify(args.name),
      args.kind ?? 'venture',
      args.legalType ?? null,
      JSON.stringify(args.metadata ?? {}),
    ],
  );
  return (r.rows[0] as VentureRow | undefined) ?? null;
}

/** One active venture by id, owner-scoped. Null if no active row matched (wrong id or owner). */
export async function getVenture(q: Q, userId: string, ventureId: string): Promise<VentureRow | null> {
  const r = await q(
    `SELECT ${COLS}
     FROM plugin_ventures.ventures
     WHERE id = $2 AND user_id = $1 AND status = 'active'`,
    [userId, ventureId],
  );
  return (r.rows[0] as VentureRow | undefined) ?? null;
}

/** All active ventures for the owner, parents before children. */
export async function listVentures(q: Q, userId: string): Promise<VentureRow[]> {
  const r = await q(
    `SELECT ${COLS}
     FROM plugin_ventures.ventures
     WHERE user_id = $1 AND status = 'active'
     ORDER BY parent_id NULLS FIRST, created_at`,
    [userId],
  );
  return r.rows as VentureRow[];
}

/**
 * A venture and all its descendants (recursive CTE), root first. Scoped to userId at every level
 * so the walk can't cross owners.
 */
export async function getSubtree(q: Q, userId: string, rootId: string): Promise<VentureRow[]> {
  const r = await q(
    `WITH RECURSIVE subtree AS (
        SELECT ${COLS}, 0 AS depth
        FROM plugin_ventures.ventures
        WHERE id = $2 AND user_id = $1 AND status = 'active'
        UNION ALL
        SELECT v.id, v.user_id, v.parent_id, v.name, v.slug, v.kind, v.legal_type, v.status,
               v.metadata, v.created_at, v.updated_at, s.depth + 1
        FROM plugin_ventures.ventures v
        JOIN subtree s ON v.parent_id = s.id
        WHERE v.user_id = $1 AND v.status = 'active'
     )
     SELECT * FROM subtree ORDER BY depth, created_at`,
    [userId, rootId],
  );
  return r.rows as VentureRow[];
}

/**
 * Move a venture under a new parent (or to top-level when null). Owner-scoped; refuses to parent a
 * node to itself. (Deeper cycle prevention — parenting under a descendant — is a follow-up.)
 * Returns true if a row moved.
 */
export async function reparent(
  q: Q,
  userId: string,
  ventureId: string,
  newParentId: string | null,
): Promise<boolean> {
  if (newParentId !== null && newParentId === ventureId) {
    throw new Error('a venture cannot be its own parent');
  }
  const r = await q(
    `UPDATE plugin_ventures.ventures
     SET parent_id = $3, updated_at = now()
     WHERE id = $2 AND user_id = $1 AND status = 'active'`,
    [userId, ventureId, newParentId],
  );
  return (r.rowCount ?? 0) > 0;
}

export interface UpdateVentureArgs {
  name?: string | null;
  /** A legal type from LEGAL_TYPES, or null to clear it. Omit (undefined) to leave it unchanged. */
  legalType?: string | null;
  /** 'active' | 'archived' — archiving a venture soft-removes it from the registry. */
  status?: string | null;
}

/**
 * Patch a venture's mutable fields (name + slug, legal_type, status). Only the keys present in
 * `patch` move; everything else is left as-is via COALESCE on a per-column sentinel. Owner-scoped,
 * and only an *active* row can be patched (so you re-activate via... not here — archiving is one-way
 * for now, a deliberate simplification). Returns the updated row, or null if nothing matched.
 */
export async function updateVenture(
  q: Q,
  userId: string,
  ventureId: string,
  patch: UpdateVentureArgs,
): Promise<VentureRow | null> {
  // Build the SET list dynamically so an omitted key is genuinely untouched (not coerced to null).
  const sets: string[] = [];
  const params: unknown[] = [userId, ventureId];
  if (patch.name !== undefined && patch.name !== null) {
    const name = patch.name.trim();
    if (!name) throw new Error('name cannot be blank');
    params.push(name);
    sets.push(`name = $${params.length}`);
    params.push(slugify(name));
    sets.push(`slug = $${params.length}`);
  }
  if (patch.legalType !== undefined) {
    params.push(patch.legalType);
    sets.push(`legal_type = $${params.length}`);
  }
  if (patch.status !== undefined && patch.status !== null) {
    params.push(patch.status);
    sets.push(`status = $${params.length}`);
  }
  if (sets.length === 0) return getVenture(q, userId, ventureId);
  sets.push('updated_at = now()');
  const r = await q(
    `UPDATE plugin_ventures.ventures
     SET ${sets.join(', ')}
     WHERE id = $2 AND user_id = $1 AND status = 'active'
     RETURNING ${COLS}`,
    params,
  );
  return (r.rows[0] as VentureRow | undefined) ?? null;
}

export interface AttachResourceArgs {
  userId: string;
  ventureId: string;
  kind: string;
  provider: string;
  externalRef: string;
  label?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Attach an external resource (account / list / analytics) to a venture. `externalRef` is the
 * provider's opaque handle/id — never a secret (credentials stay in the vault). The per-owner
 * active unique index rejects attaching the same (provider, external_ref) twice.
 */
export async function attachResource(q: Q, args: AttachResourceArgs): Promise<ResourceRow | null> {
  const r = await q(
    `INSERT INTO plugin_ventures.venture_resources
        (venture_id, user_id, kind, provider, external_ref, label, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING ${RES_COLS}`,
    [
      args.ventureId,
      args.userId,
      args.kind,
      args.provider,
      args.externalRef,
      args.label ?? null,
      JSON.stringify(args.metadata ?? {}),
    ],
  );
  return (r.rows[0] as ResourceRow | undefined) ?? null;
}

/** Active resources for the owner, optionally scoped to one venture. */
export async function listResources(
  q: Q,
  userId: string,
  ventureId?: string | null,
): Promise<ResourceRow[]> {
  if (ventureId == null) {
    const r = await q(
      `SELECT ${RES_COLS}
       FROM plugin_ventures.venture_resources
       WHERE user_id = $1 AND status = 'active'
       ORDER BY created_at`,
      [userId],
    );
    return r.rows as ResourceRow[];
  }
  const r = await q(
    `SELECT ${RES_COLS}
     FROM plugin_ventures.venture_resources
     WHERE user_id = $1 AND venture_id = $2 AND status = 'active'
     ORDER BY created_at`,
    [userId, ventureId],
  );
  return r.rows as ResourceRow[];
}

/**
 * Soft-detach a resource (status -> archived). Owner-scoped. Soft so history survives + the active
 * unique index frees the (provider, external_ref) for re-attach. Returns true if a row moved.
 */
export async function detachResource(q: Q, userId: string, resourceId: string): Promise<boolean> {
  const r = await q(
    `UPDATE plugin_ventures.venture_resources
     SET status = 'archived', updated_at = now()
     WHERE id = $2 AND user_id = $1 AND status = 'active'`,
    [userId, resourceId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Move a resource to a different venture — reassign its venture_id. Owner-scoped on both the resource
 * and (by the caller) the target venture. The account itself (the social plugin's connection) doesn't
 * move; only which venture claims it. Returns the updated row, or null if no active resource matched.
 */
export async function moveResource(
  q: Q,
  userId: string,
  resourceId: string,
  newVentureId: string,
): Promise<ResourceRow | null> {
  const r = await q(
    `UPDATE plugin_ventures.venture_resources
     SET venture_id = $3, updated_at = now()
     WHERE id = $2 AND user_id = $1 AND status = 'active'
     RETURNING ${RES_COLS}`,
    [userId, resourceId, newVentureId],
  );
  return (r.rows[0] as ResourceRow | undefined) ?? null;
}

/**
 * Fold an identity profile (e.g. a Companies House record) into a venture's metadata.identity
 * (charles#16). Merges under the `identity` key so other metadata survives. Owner-scoped;
 * returns the updated row, or null if no active venture matched.
 */
export async function setVentureIdentity(
  q: Q,
  userId: string,
  ventureId: string,
  identity: Record<string, unknown>,
): Promise<VentureRow | null> {
  const r = await q(
    `UPDATE plugin_ventures.ventures
     SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{identity}', $3::jsonb, true),
         updated_at = now()
     WHERE id = $2 AND user_id = $1 AND status = 'active'
     RETURNING ${COLS}`,
    [userId, ventureId, JSON.stringify(identity)],
  );
  return (r.rows[0] as VentureRow | undefined) ?? null;
}

/**
 * Store a venture's lightweight plan/state under metadata.plan (charles#21). The plan is a
 * small free-form jsonb blob — what Charles is doing in this venture (goal, status, next steps) —
 * kept on the venture itself so a venture's "state" lives in one place next to its identity. Merged
 * under the `plan` key so identity + any other metadata survive. Owner-scoped; null if no match.
 */
export async function setVenturePlan(
  q: Q,
  userId: string,
  ventureId: string,
  plan: Record<string, unknown>,
): Promise<VentureRow | null> {
  const r = await q(
    `UPDATE plugin_ventures.ventures
     SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{plan}', $3::jsonb, true),
         updated_at = now()
     WHERE id = $2 AND user_id = $1 AND status = 'active'
     RETURNING ${COLS}`,
    [userId, ventureId, JSON.stringify(plan)],
  );
  return (r.rows[0] as VentureRow | undefined) ?? null;
}

/**
 * Set a venture's free-text prompt — operator-authored standing context/instructions for the
 * venture ("what is this, who's it for, how should you act here"). Distinct from `plan` (the agent's
 * working state): `prompt` is the human's durable context, surfaced to the agent via venture_get so
 * every venture of any kind can carry more context. Stored under metadata.prompt; an empty/blank
 * value removes the key. Owner-scoped; null if no active venture matched.
 */
export async function setVenturePrompt(
  q: Q,
  userId: string,
  ventureId: string,
  prompt: string,
): Promise<VentureRow | null> {
  const trimmed = prompt.trim();
  const r = await q(
    trimmed
      ? `UPDATE plugin_ventures.ventures
         SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{prompt}', $3::jsonb, true),
             updated_at = now()
         WHERE id = $2 AND user_id = $1 AND status = 'active'
         RETURNING ${COLS}`
      : `UPDATE plugin_ventures.ventures
         SET metadata = COALESCE(metadata, '{}'::jsonb) - 'prompt', updated_at = now()
         WHERE id = $2 AND user_id = $1 AND status = 'active'
         RETURNING ${COLS}`,
    trimmed ? [userId, ventureId, JSON.stringify(trimmed)] : [userId, ventureId],
  );
  return (r.rows[0] as VentureRow | undefined) ?? null;
}

// ── Venture items (build -> plan: tasks / ideas / notes under a venture, charles#21) ────────

export interface AddItemArgs {
  userId: string;
  ventureId: string;
  kind?: string;
  title: string;
  body?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Add a working item (task / idea / note) to a venture. Owner- and venture-scoped: the insert is
 * guarded by a sub-select so an item can't be attached to a venture the caller doesn't own (or one
 * that's archived). Returns the row, or null if the venture didn't resolve.
 */
export async function addItem(q: Q, args: AddItemArgs): Promise<ItemRow | null> {
  const r = await q(
    `INSERT INTO plugin_ventures.venture_items (venture_id, user_id, kind, title, body, metadata)
     SELECT v.id, $1, $3, $4, $5, $6::jsonb
     FROM plugin_ventures.ventures v
     WHERE v.id = $2 AND v.user_id = $1 AND v.status = 'active'
     RETURNING ${ITEM_COLS}`,
    [
      args.userId,
      args.ventureId,
      args.kind ?? 'task',
      args.title,
      args.body ?? null,
      JSON.stringify(args.metadata ?? {}),
    ],
  );
  return (r.rows[0] as ItemRow | undefined) ?? null;
}

/**
 * Items under a venture, owner-scoped. Excludes archived (the soft-delete tombstone) by default;
 * pass includeArchived to see them. Newest first — the working surface reads top-down.
 */
export async function listItems(
  q: Q,
  userId: string,
  ventureId: string,
  includeArchived = false,
): Promise<ItemRow[]> {
  const r = await q(
    `SELECT ${ITEM_COLS}
     FROM plugin_ventures.venture_items
     WHERE user_id = $1 AND venture_id = $2
       AND ($3 OR status <> 'archived')
     ORDER BY created_at DESC`,
    [userId, ventureId, includeArchived],
  );
  return r.rows as ItemRow[];
}

/**
 * Move an item to a new status (open / doing / done / archived) — the build progression, plus
 * 'archived' as the soft delete. Owner-scoped. Returns the updated row, or null if nothing matched.
 */
export async function setItemStatus(
  q: Q,
  userId: string,
  itemId: string,
  status: string,
): Promise<ItemRow | null> {
  const r = await q(
    `UPDATE plugin_ventures.venture_items
     SET status = $3, updated_at = now()
     WHERE id = $2 AND user_id = $1
     RETURNING ${ITEM_COLS}`,
    [userId, itemId, status],
  );
  return (r.rows[0] as ItemRow | undefined) ?? null;
}
