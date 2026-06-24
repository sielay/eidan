// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent tools for the ventures harness (charles#12). These let the eidan brain manage the
// operator's venture tree conversationally ("set up Acme Ltd with two ventures under it").
// Tools close over the plugin's Db (built at setup); the acting user_id comes from the ambient
// matbot Principal (set per turn by the runner), so reads/writes are owner-scoped.
import type { Tool, JSONSchema } from '@matatbread/matbot-plugin-api';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';

// Cross-plugin (matbot registry idiom): the social-* plugins register a SocialConnections lookup so
// we can verify a handle is actually connected before attaching it as a venture resource — without a
// hard dep on those plugins. Structurally re-declared; the string key matches at runtime.
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    SocialConnections?: {
      providers(): string[];
      lookup(provider: string, handle: string): Promise<{ externalId: string; handle: string } | null>;
    };
  }
}
export type SocialConnectionsLookup = NonNullable<
  import('@matatbread/matbot-plugin-api').MatbotServices['SocialConnections']
>;
import type { Db, Q } from './db.js';
import type { ItemRow, ResourceRow, VentureRow } from './store.js';
import * as store from './store.js';
import { CompaniesHouseError, lookupCompany } from './identity.js';
import {
  RESOURCE_KINDS,
  availableProviders,
  availableProvidersByKind,
  getAdapter,
  isAvailable,
  isResourceKind,
  plannedProvidersByKind,
} from './providers.js';

const KINDS = ['org', 'venture', 'project'];
const LEGAL_TYPES = ['ltd', 'sole_trader', 'holding'];
// Attachable resource kinds + the providers offered for each — sourced from the adapter registry
// (providers.ts), which gates on whether a working adapter actually backs a provider. The schema
// enum and the runtime validation below both derive from it, so an unsupported provider is never
// offered (Track V1, charles_provider_abstraction).
const RES_KINDS = [...RESOURCE_KINDS];
const RES_PROVIDERS = availableProviders();
const ITEM_KINDS = ['task', 'idea', 'note'];
const ITEM_STATUSES = ['open', 'doing', 'done', 'archived'];
const VENTURE_STATUSES = ['active', 'archived'];
const CH_KEY_ENV = 'EIDAN_COMPANIES_HOUSE_KEY';

const CREATE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Venture/org/project name.', minLength: 1 },
    kind: { type: 'string', enum: KINDS, description: "Role in the tree (default 'venture')." },
    legal_type: { type: 'string', enum: LEGAL_TYPES, description: 'Legal nature, for formal orgs (optional).' },
    parent_id: { type: 'string', description: 'Parent venture id; omit for a top-level org/venture.' },
    parent: { type: 'string', description: "Parent venture by name, slug, or id — nests the new venture under it (e.g. 'a blog' under 'Acme Ltd'). Resolved owner-scoped; omit (or omit parent_id) for a top-level org/venture." },
  },
  required: ['name'],
  additionalProperties: false,
};

const REPARENT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    venture_id: { type: 'string', description: 'The venture to move.', minLength: 1 },
    parent: { type: ['string', 'null'], description: 'New parent venture by name, slug, or id; omit or pass null to move it to the top level.' },
  },
  required: ['venture_id'],
  additionalProperties: false,
};

const LIST_SCHEMA: JSONSchema = { type: 'object', properties: {}, additionalProperties: false };

const ATTACH_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    venture_id: { type: 'string', description: 'The venture to attach the resource to.', minLength: 1 },
    kind: { type: 'string', enum: RES_KINDS, description: 'Resource kind.' },
    provider: { type: 'string', enum: RES_PROVIDERS, description: "Integration provider backing the resource. Only adapter-backed providers are attachable; today that is 'manual' (operator-tracked by hand) for every kind. Vendor/platform providers (x, linkedin, ga4, …) are roadmapped but not yet attachable — attach as 'manual' until their adapter ships." },
    external_ref: { type: 'string', description: "The provider's handle/id for the resource (NOT a secret — creds stay in the vault).", minLength: 1 },
    label: { type: 'string', description: 'Human label (optional).' },
  },
  required: ['venture_id', 'kind', 'provider', 'external_ref'],
  additionalProperties: false,
};

const RESOURCES_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    venture_id: { type: 'string', description: "Scope to one venture; omit for all of the operator's resources." },
  },
  additionalProperties: false,
};

const LOOKUP_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    registration_number: { type: 'string', description: 'UK Companies House number (8 digits, or SC/NI/OC + 6 digits).', minLength: 1 },
    venture_id: { type: 'string', description: 'Venture to fold the official record into (its identity profile); omit to just look up.' },
  },
  required: ['registration_number'],
  additionalProperties: false,
};

const GET_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    venture_id: { type: 'string', description: 'The venture to inspect.', minLength: 1 },
  },
  required: ['venture_id'],
  additionalProperties: false,
};

const UPDATE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    venture_id: { type: 'string', description: 'The venture to update.', minLength: 1 },
    name: { type: 'string', description: 'New name (also re-slugs); omit to leave unchanged.', minLength: 1 },
    legal_type: { type: ['string', 'null'], enum: [...LEGAL_TYPES, null], description: 'New legal type, or null to clear it; omit to leave unchanged.' },
    status: { type: 'string', enum: VENTURE_STATUSES, description: "'archived' soft-removes the venture; omit to leave unchanged." },
  },
  required: ['venture_id'],
  additionalProperties: false,
};

const SET_PLAN_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    venture_id: { type: 'string', description: 'The venture whose plan/state to set.', minLength: 1 },
    plan: { type: 'object', description: "The venture's lightweight plan/state — a small free-form object (e.g. goal, status, next_steps). Replaces the stored plan." },
  },
  required: ['venture_id', 'plan'],
  additionalProperties: false,
};

const ADD_ITEM_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    venture_id: { type: 'string', description: 'The venture to attach the item to.', minLength: 1 },
    kind: { type: 'string', enum: ITEM_KINDS, description: "Item kind (default 'task')." },
    title: { type: 'string', description: 'Short title for the task / idea / note.', minLength: 1 },
    body: { type: 'string', description: 'Optional longer detail.' },
  },
  required: ['venture_id', 'title'],
  additionalProperties: false,
};

const ITEMS_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    venture_id: { type: 'string', description: 'The venture whose items to list.', minLength: 1 },
    include_archived: { type: 'boolean', description: 'Include soft-deleted (archived) items (default false).' },
  },
  required: ['venture_id'],
  additionalProperties: false,
};

const SET_ITEM_STATUS_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    item_id: { type: 'string', description: 'The item to move.', minLength: 1 },
    status: { type: 'string', enum: ITEM_STATUSES, description: "New status: the build progression open -> doing -> done, plus 'archived' as the soft delete." },
  },
  required: ['item_id', 'status'],
  additionalProperties: false,
};

const VIEW_FIELDS = ['id', 'parent_id', 'name', 'slug', 'kind', 'legal_type', 'status'] as const;
const RES_VIEW_FIELDS = ['id', 'venture_id', 'kind', 'provider', 'external_ref', 'label', 'status'] as const;
const ITEM_VIEW_FIELDS = ['id', 'venture_id', 'kind', 'title', 'body', 'status'] as const;

function view(row: VentureRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of VIEW_FIELDS) out[k] = row[k];
  return out;
}

function resView(row: ResourceRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of RES_VIEW_FIELDS) out[k] = row[k];
  return out;
}

function itemView(row: ItemRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ITEM_VIEW_FIELDS) out[k] = row[k];
  return out;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/**
 * Resolve a parent reference — a venture's id, slug, or name — to its id, owner-scoped. Returns the
 * matched venture id, or null if nothing active matched (the caller surfaces a clear error). Matches
 * id first, then exact slug, then exact name, then a slugified-name fallback so a free-form name
 * ('Acme Ltd') still finds a venture stored under its slug ('acme-ltd').
 */
async function resolveVentureRef(q: Q, userId: string, ref: string): Promise<string | null> {
  const needle = ref.trim();
  if (!needle) return null;
  const rows = await store.listVentures(q, userId);
  const slugged = store.slugify(needle);
  const lower = needle.toLowerCase();
  const match =
    rows.find((r) => r.id === needle) ??
    rows.find((r) => r.slug === needle) ??
    rows.find((r) => r.name.toLowerCase() === lower) ??
    rows.find((r) => r.slug === slugged);
  return match?.id ?? null;
}

/** Build the venture tools, closed over the plugin's Db. */
export function buildVenturesTools(db: Db, social?: SocialConnectionsLookup): Tool[] {
  return [
    {
      name: 'ventures_create',
      description:
        "Create a venture (org / venture / project) in the operator's venture tree. Nest it by " +
        "passing parent (a parent's name, slug, or id — e.g. 'Acme Ltd') or parent_id; omit both " +
        'for a top-level org. Use when the operator describes a new company, project, or sub-venture.',
      inputSchema: CREATE_SCHEMA,
      executor: {
        async *execute(input) {
          const uid = tryCurrentPrincipal()?.id;
          if (!uid) return yield { type: 'error', message: 'no user context — ventures are owner-scoped' };
          const args = (input ?? {}) as Record<string, unknown>;
          const name = str(args['name']).trim();
          if (!name) return yield { type: 'error', message: 'name is required' };
          const kind = str(args['kind']) || 'venture';
          if (!KINDS.includes(kind)) return yield { type: 'error', message: `kind must be one of ${KINDS.join(', ')}` };
          const legalType = args['legal_type'] == null ? null : str(args['legal_type']);
          if (legalType !== null && !LEGAL_TYPES.includes(legalType)) {
            return yield { type: 'error', message: `legal_type must be one of ${LEGAL_TYPES.join(', ')}` };
          }
          // parent_id (explicit id) or parent (name/slug/id, resolved owner-scoped). parent wins if both.
          const parentRef = args['parent'] == null ? '' : str(args['parent']).trim();
          const parentIdInput = args['parent_id'] == null ? null : str(args['parent_id']);
          const result = await db.withPrincipalTx<{ row: VentureRow | null; error?: string }>(async (q) => {
            let parentId = parentIdInput;
            if (parentRef) {
              const resolved = await resolveVentureRef(q, uid, parentRef);
              if (!resolved) return { row: null, error: `no such parent venture: '${parentRef}'` };
              parentId = resolved;
            }
            const row = await store.createVenture(q, { userId: uid, name, kind, legalType, parentId });
            return { row };
          });
          if (result.error) return yield { type: 'error', message: result.error };
          if (!result.row) return yield { type: 'error', message: 'could not create venture' };
          yield { type: 'result', value: view(result.row) };
        },
      },
    },
    {
      name: 'ventures_list',
      description:
        "List the operator's ventures (the org/venture/project tree). Use to recall what they're " +
        'running before scoping other work (campaigns, decks, analytics) to a venture.',
      inputSchema: LIST_SCHEMA,
      executor: {
        async *execute() {
          const uid = tryCurrentPrincipal()?.id;
          if (!uid) return yield { type: 'error', message: 'no user context — ventures are owner-scoped' };
          const rows = await db.withPrincipalTx((q) => store.listVentures(q, uid));
          // parent_id is already in the view; add the parent's name so the tree is readable at a glance.
          const byId = new Map(rows.map((r) => [r.id, r.name]));
          const ventures = rows.map((r) => ({
            ...view(r),
            parent_name: r.parent_id ? byId.get(r.parent_id) ?? null : null,
          }));
          yield { type: 'result', value: { ventures } };
        },
      },
    },
    {
      name: 'venture_get',
      description:
        'Inspect one venture in full: its core fields plus its stored plan/state and identity ' +
        '(from metadata), its working items (tasks / ideas / notes), and its attached resources. ' +
        'Use to reason over everything a venture holds before planning or acting within it.',
      inputSchema: GET_SCHEMA,
      executor: {
        async *execute(input) {
          const uid = tryCurrentPrincipal()?.id;
          if (!uid) return yield { type: 'error', message: 'no user context — ventures are owner-scoped' };
          const args = (input ?? {}) as Record<string, unknown>;
          const ventureId = str(args['venture_id']).trim();
          if (!ventureId) return yield { type: 'error', message: 'venture_id is required' };
          const result = await db.withPrincipalTx(async (q) => {
            const v = await store.getVenture(q, uid, ventureId);
            if (!v) return null;
            const items = await store.listItems(q, uid, ventureId);
            const resources = await store.listResources(q, uid, ventureId);
            // Direct children + the parent reference, so the agent can see this venture's place in the tree.
            const subtree = await store.getSubtree(q, uid, ventureId);
            const children = subtree.filter((r) => r.parent_id === v.id);
            const parent = v.parent_id ? await store.getVenture(q, uid, v.parent_id) : null;
            return { v, items, resources, children, parent };
          });
          if (!result) return yield { type: 'error', message: 'no such venture' };
          yield {
            type: 'result',
            value: {
              ...view(result.v),
              parent: result.parent ? { id: result.parent.id, name: result.parent.name } : null,
              plan: result.v.metadata['plan'] ?? null,
              identity: result.v.metadata['identity'] ?? null,
              children: result.children.map(view),
              items: result.items.map(itemView),
              resources: result.resources.map(resView),
            },
          };
        },
      },
    },
    {
      name: 'venture_update',
      description:
        "Update a venture's mutable fields — rename it (which re-slugs), set/clear its legal type, " +
        "or archive it (status='archived' soft-removes it from the registry). Only the fields you " +
        'pass change. Use when the operator corrects or retires a venture.',
      inputSchema: UPDATE_SCHEMA,
      executor: {
        async *execute(input) {
          const uid = tryCurrentPrincipal()?.id;
          if (!uid) return yield { type: 'error', message: 'no user context — ventures are owner-scoped' };
          const args = (input ?? {}) as Record<string, unknown>;
          const ventureId = str(args['venture_id']).trim();
          if (!ventureId) return yield { type: 'error', message: 'venture_id is required' };
          const patch: store.UpdateVentureArgs = {};
          if (args['name'] !== undefined) {
            const name = str(args['name']).trim();
            if (!name) return yield { type: 'error', message: 'name cannot be blank' };
            patch.name = name;
          }
          // legal_type: explicit null clears it; a string sets it; omitted leaves it.
          if ('legal_type' in args) {
            const lt = args['legal_type'];
            if (lt !== null) {
              const s = str(lt);
              if (!LEGAL_TYPES.includes(s)) return yield { type: 'error', message: `legal_type must be one of ${LEGAL_TYPES.join(', ')} (or null)` };
              patch.legalType = s;
            } else {
              patch.legalType = null;
            }
          }
          if (args['status'] !== undefined) {
            const status = str(args['status']);
            if (!VENTURE_STATUSES.includes(status)) return yield { type: 'error', message: `status must be one of ${VENTURE_STATUSES.join(', ')}` };
            patch.status = status;
          }
          const row = await db.withPrincipalTx((q) => store.updateVenture(q, uid, ventureId, patch));
          if (!row) return yield { type: 'error', message: 'no such venture' };
          yield { type: 'result', value: view(row) };
        },
      },
    },
    {
      name: 'venture_reparent',
      description:
        'Move a venture to a new place in the tree — nest it under another venture (by name, slug, ' +
        'or id) or, with no parent, lift it to the top level. Use when the operator reorganises the ' +
        'tree (e.g. moves a project under a different org). A venture cannot be its own parent.',
      inputSchema: REPARENT_SCHEMA,
      executor: {
        async *execute(input) {
          const uid = tryCurrentPrincipal()?.id;
          if (!uid) return yield { type: 'error', message: 'no user context — ventures are owner-scoped' };
          const args = (input ?? {}) as Record<string, unknown>;
          const ventureId = str(args['venture_id']).trim();
          if (!ventureId) return yield { type: 'error', message: 'venture_id is required' };
          const parentRef = args['parent'] == null ? '' : str(args['parent']).trim();
          const result = await db.withPrincipalTx<{ row: VentureRow | null; error?: string }>(async (q) => {
            let newParentId: string | null = null;
            if (parentRef) {
              const resolved = await resolveVentureRef(q, uid, parentRef);
              if (!resolved) return { row: null, error: `no such parent venture: '${parentRef}'` };
              newParentId = resolved;
            }
            let moved: boolean;
            try {
              moved = await store.reparent(q, uid, ventureId, newParentId);
            } catch (exc) {
              // Surface the store's self-parent guard (and any future cycle guard) clearly.
              return { row: null, error: exc instanceof Error ? exc.message : String(exc) };
            }
            if (!moved) return { row: null };
            return { row: await store.getVenture(q, uid, ventureId) };
          });
          if (result.error) return yield { type: 'error', message: result.error };
          if (!result.row) return yield { type: 'error', message: 'no such venture' };
          yield { type: 'result', value: view(result.row) };
        },
      },
    },
    {
      name: 'venture_set_plan',
      description:
        "Store a venture's lightweight plan/state — what Charles is doing in this venture (goal, " +
        'status, next steps) — as a small free-form object kept on the venture itself, next to its ' +
        'identity. Replaces the stored plan. Use to record or revise the working plan for a venture.',
      inputSchema: SET_PLAN_SCHEMA,
      executor: {
        async *execute(input) {
          const uid = tryCurrentPrincipal()?.id;
          if (!uid) return yield { type: 'error', message: 'no user context — ventures are owner-scoped' };
          const args = (input ?? {}) as Record<string, unknown>;
          const ventureId = str(args['venture_id']).trim();
          if (!ventureId) return yield { type: 'error', message: 'venture_id is required' };
          const plan = args['plan'];
          if (plan == null || typeof plan !== 'object' || Array.isArray(plan)) {
            return yield { type: 'error', message: 'plan must be an object' };
          }
          const row = await db.withPrincipalTx((q) =>
            store.setVenturePlan(q, uid, ventureId, plan as Record<string, unknown>),
          );
          if (!row) return yield { type: 'error', message: 'no such venture' };
          yield { type: 'result', value: { ...view(row), plan: row.metadata['plan'] ?? null } };
        },
      },
    },
    {
      name: 'venture_add_item',
      description:
        'Add a working item to a venture — a task, idea, or note (build -> plan: the things to do / ' +
        'consider / remember inside a venture). Use when the operator captures work or thinking ' +
        'against a specific venture.',
      inputSchema: ADD_ITEM_SCHEMA,
      executor: {
        async *execute(input) {
          const uid = tryCurrentPrincipal()?.id;
          if (!uid) return yield { type: 'error', message: 'no user context — ventures are owner-scoped' };
          const args = (input ?? {}) as Record<string, unknown>;
          const ventureId = str(args['venture_id']).trim();
          if (!ventureId) return yield { type: 'error', message: 'venture_id is required' };
          const title = str(args['title']).trim();
          if (!title) return yield { type: 'error', message: 'title is required' };
          const kind = args['kind'] == null ? 'task' : str(args['kind']);
          if (!ITEM_KINDS.includes(kind)) return yield { type: 'error', message: `kind must be one of ${ITEM_KINDS.join(', ')}` };
          const body = args['body'] == null ? null : str(args['body']);
          const row = await db.withPrincipalTx((q) =>
            store.addItem(q, { userId: uid, ventureId, kind, title, body }),
          );
          if (!row) return yield { type: 'error', message: 'no such venture to attach the item to' };
          yield { type: 'result', value: itemView(row) };
        },
      },
    },
    {
      name: 'venture_items',
      description:
        'List the working items (tasks / ideas / notes) under a venture, newest first. Excludes ' +
        'archived items unless include_archived is set. Use to review what is open or in progress ' +
        'in a venture.',
      inputSchema: ITEMS_SCHEMA,
      executor: {
        async *execute(input) {
          const uid = tryCurrentPrincipal()?.id;
          if (!uid) return yield { type: 'error', message: 'no user context — ventures are owner-scoped' };
          const args = (input ?? {}) as Record<string, unknown>;
          const ventureId = str(args['venture_id']).trim();
          if (!ventureId) return yield { type: 'error', message: 'venture_id is required' };
          const includeArchived = args['include_archived'] === true;
          const rows = await db.withPrincipalTx((q) => store.listItems(q, uid, ventureId, includeArchived));
          yield { type: 'result', value: { items: rows.map(itemView) } };
        },
      },
    },
    {
      name: 'venture_set_item_status',
      description:
        "Move a venture item along its build progression — open -> doing -> done — or 'archived' to " +
        'soft-delete it. Use when the operator starts, finishes, or drops a task/idea/note.',
      inputSchema: SET_ITEM_STATUS_SCHEMA,
      executor: {
        async *execute(input) {
          const uid = tryCurrentPrincipal()?.id;
          if (!uid) return yield { type: 'error', message: 'no user context — ventures are owner-scoped' };
          const args = (input ?? {}) as Record<string, unknown>;
          const itemId = str(args['item_id']).trim();
          if (!itemId) return yield { type: 'error', message: 'item_id is required' };
          const status = str(args['status']);
          if (!ITEM_STATUSES.includes(status)) return yield { type: 'error', message: `status must be one of ${ITEM_STATUSES.join(', ')}` };
          const row = await db.withPrincipalTx((q) => store.setItemStatus(q, uid, itemId, status));
          if (!row) return yield { type: 'error', message: 'no such item' };
          yield { type: 'result', value: itemView(row) };
        },
      },
    },
    {
      name: 'venture_attach_resource',
      description:
        'Attach an external resource to a venture — a social account, mailing list, or analytics ' +
        "property (many per venture). Store the provider's handle/id in external_ref, NOT " +
        'credentials (those live in the vault). Use when the operator links an account/list/' +
        'analytics to a venture.',
      inputSchema: ATTACH_SCHEMA,
      executor: {
        async *execute(input) {
          const uid = tryCurrentPrincipal()?.id;
          if (!uid) return yield { type: 'error', message: 'no user context — ventures are owner-scoped' };
          const args = (input ?? {}) as Record<string, unknown>;
          const kind = str(args['kind']);
          if (!isResourceKind(kind)) return yield { type: 'error', message: `kind must be one of ${RES_KINDS.join(', ')}` };
          for (const field of ['venture_id', 'provider', 'external_ref']) {
            if (!str(args[field]).trim()) return yield { type: 'error', message: `${field} is required` };
          }
          const provider = str(args['provider']).trim();
          if (!isAvailable(kind, provider)) {
            const available = availableProvidersByKind()[kind] ?? [];
            const planned = plannedProvidersByKind()[kind] ?? [];
            const plannedNote = planned.length ? ` (${planned.join(', ')} are roadmapped but have no adapter yet — attach as 'manual' for now)` : '';
            return yield { type: 'error', message: `provider for a ${kind} must be one of: ${available.join(', ')}${plannedNote}` };
          }
          // Resolve/normalise external_ref via the provider's adapter (Track V2) — never persist a
          // raw free string. The adapter exists because the provider passed the availability check.
          let externalRef = str(args['external_ref']).trim();
          const resolve = getAdapter(kind, provider)?.resolveRef;
          if (resolve) {
            const resolved = resolve(externalRef);
            if (!resolved.ok) return yield { type: 'error', message: `external_ref: ${resolved.error}` };
            externalRef = resolved.value ?? externalRef;
          }
          // Live check: when a social-* plugin is loaded and backs this provider, require the handle to
          // be an actually-connected account (and canonicalise to its registry handle). Skipped when the
          // plugin isn't loaded so Charles still works standalone (and for non-social providers).
          if (social && kind === 'social_account' && social.providers().includes(provider)) {
            const found = await social.lookup(provider, externalRef);
            if (!found) {
              return yield {
                type: 'error',
                message:
                  `no connected ${provider} account matches "${externalRef}" — connect it under ` +
                  `Connections first, or attach it as provider 'manual' to track it by hand.`,
              };
            }
            externalRef = found.handle || externalRef;
          }
          const label = args['label'] == null ? null : str(args['label']);
          const row = await db.withPrincipalTx((q) =>
            store.attachResource(q, {
              userId: uid,
              ventureId: str(args['venture_id']),
              kind,
              provider,
              externalRef,
              label,
            }),
          );
          if (!row) return yield { type: 'error', message: 'could not attach resource' };
          yield { type: 'result', value: resView(row) };
        },
      },
    },
    {
      name: 'venture_resources',
      description:
        'List the external resources (social accounts, mailing lists, analytics) attached to a ' +
        'venture (or all, if none given). Use before planning content/campaigns to know which ' +
        'channels a venture has.',
      inputSchema: RESOURCES_SCHEMA,
      executor: {
        async *execute(input) {
          const uid = tryCurrentPrincipal()?.id;
          if (!uid) return yield { type: 'error', message: 'no user context — ventures are owner-scoped' };
          const args = (input ?? {}) as Record<string, unknown>;
          const ventureId = args['venture_id'] == null ? null : str(args['venture_id']);
          const rows = await db.withPrincipalTx((q) => store.listResources(q, uid, ventureId));
          yield { type: 'result', value: { resources: rows.map(resView) } };
        },
      },
    },
    {
      name: 'venture_lookup_company',
      description:
        'Look up a UK company on Companies House by registration number and fold the official ' +
        'record (legal name, status, type, incorporation date, registered office, SIC codes) into ' +
        "a venture's identity profile. Use when the operator gives a company number, or to verify/" +
        "enrich a UK venture's identity. UK-only; non-UK registries aren't covered yet.",
      inputSchema: LOOKUP_SCHEMA,
      executor: {
        async *execute(input) {
          const uid = tryCurrentPrincipal()?.id;
          if (!uid) return yield { type: 'error', message: 'no user context — ventures are owner-scoped' };
          const args = (input ?? {}) as Record<string, unknown>;
          const number = str(args['registration_number']).trim();
          if (!number) return yield { type: 'error', message: 'registration_number is required' };
          const apiKey = process.env[CH_KEY_ENV];
          if (!apiKey) {
            return yield {
              type: 'error',
              message: `Companies House lookup is not configured (set ${CH_KEY_ENV} — a free key from the CH developer hub)`,
            };
          }
          let identityProfile: Record<string, unknown>;
          try {
            identityProfile = await lookupCompany(number, { apiKey });
          } catch (exc) {
            if (exc instanceof CompaniesHouseError) return yield { type: 'error', message: exc.message };
            throw exc;
          }
          let linked = false;
          const ventureId = str(args['venture_id']).trim();
          if (ventureId) {
            const row = await db.withPrincipalTx((q) =>
              store.setVentureIdentity(q, uid, ventureId, identityProfile),
            );
            if (!row) return yield { type: 'error', message: 'no such venture to link the identity to' };
            linked = true;
          }
          yield { type: 'result', value: { identity: identityProfile, linked_to_venture: linked } };
        },
      },
    },
  ];
}
