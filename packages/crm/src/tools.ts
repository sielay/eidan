// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool, JSONSchema } from '@matatbread/matbot-plugin-api';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import type { CrmDb, Q } from './db.js';

const CONTACT_CREATE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    venture_id: { type: 'string', description: 'Venture ID (UUID).', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
    name: { type: 'string', description: 'Contact name.', minLength: 1 },
    email: { type: 'string', description: 'Email address (optional).' },
    phone: { type: 'string', description: 'Phone number (optional).' },
    company: { type: 'string', description: 'Company (optional).' },
    role: { type: 'string', description: 'Job title or role (optional).' },
  },
  required: ['venture_id', 'name'],
  additionalProperties: false,
};

const CONTACT_UPDATE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    contact_id: { type: 'string', description: 'Contact ID to update.', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
    name: { type: 'string', description: 'Contact name.' },
    email: { type: 'string', description: 'Email address.' },
    phone: { type: 'string', description: 'Phone number.' },
    company: { type: 'string', description: 'Company.' },
    role: { type: 'string', description: 'Job title or role.' },
  },
  required: ['contact_id'],
  additionalProperties: false,
};

const CONTACT_GET_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    contact_id: { type: 'string', description: 'Contact ID.', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
  },
  required: ['contact_id'],
  additionalProperties: false,
};

const CONTACT_LIST_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    venture_id: { type: 'string', description: 'Filter by venture ID.' },
  },
  additionalProperties: false,
};

const DEAL_CREATE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    venture_id: { type: 'string', description: 'Venture ID.', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
    name: { type: 'string', description: 'Deal name.', minLength: 1 },
    contact_id: { type: ['string', 'null'], description: 'Associated contact ID (optional).', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
    value_cents: { type: 'integer', description: 'Value in cents (default 0).', minimum: 0 },
    currency: { type: 'string', description: 'Currency code (default GBP).', enum: ['GBP', 'USD', 'EUR'] },
    stage: { type: 'string', description: 'Pipeline stage.', enum: ['lead', 'qualified', 'proposal', 'won', 'lost'] },
  },
  required: ['venture_id', 'name', 'stage'],
  additionalProperties: false,
};

const DEAL_UPDATE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    deal_id: { type: 'string', description: 'Deal ID.', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
    name: { type: 'string', description: 'Deal name.' },
    value_cents: { type: 'integer', description: 'Value in cents.', minimum: 0 },
    currency: { type: 'string', description: 'Currency code.', enum: ['GBP', 'USD', 'EUR'] },
    stage: { type: 'string', description: 'Pipeline stage.', enum: ['lead', 'qualified', 'proposal', 'won', 'lost'] },
    contact_id: { type: ['string', 'null'], description: 'Associated contact (null to unlink).', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
    expected_close: { type: 'string', description: 'Expected close date (YYYY-MM-DD).' },
  },
  required: ['deal_id'],
  additionalProperties: false,
};

const DEAL_MOVE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    deal_id: { type: 'string', description: 'Deal ID.', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
    stage: { type: 'string', description: 'New stage.', enum: ['lead', 'qualified', 'proposal', 'won', 'lost'] },
    position: { type: 'integer', description: 'Position within stage (optional).', minimum: 0 },
  },
  required: ['deal_id', 'stage'],
  additionalProperties: false,
};

const DEAL_GET_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    deal_id: { type: 'string', description: 'Deal ID.', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
  },
  required: ['deal_id'],
  additionalProperties: false,
};

const DEAL_LIST_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    venture_id: { type: 'string', description: 'Filter by venture ID.' },
    stage: { type: 'string', description: 'Filter by stage (optional).' },
  },
  additionalProperties: false,
};

const ACTIVITY_LOG_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    venture_id: { type: 'string', description: 'Venture ID.', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
    kind: { type: 'string', enum: ['call', 'email', 'note', 'meeting', 'stage_change'], description: 'Activity kind.' },
    body: { type: ['string', 'null'], description: 'Activity description or body.' },
    deal_id: { type: ['string', 'null'], description: 'Associated deal (optional).', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
    contact_id: { type: ['string', 'null'], description: 'Associated contact (optional).', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
  },
  required: ['venture_id', 'kind'],
  additionalProperties: false,
};

const ACTIVITY_LIST_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    venture_id: { type: 'string', description: 'Venture ID.', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
    deal_id: { type: ['string', 'null'], description: 'Filter by deal ID.', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
    contact_id: { type: ['string', 'null'], description: 'Filter by contact ID.', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' },
  },
  required: ['venture_id'],
  additionalProperties: false,
};

function uid(): string | null {
  return tryCurrentPrincipal()?.id ?? null;
}

export function buildCrmTools(db: CrmDb): Tool[] {
  return [
    {
      name: 'crm_contact',
      description: 'Create, update, list, or get CRM contacts.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'update', 'list', 'get'], description: 'Action to perform.' },
          ...CONTACT_CREATE_SCHEMA.properties,
          ...CONTACT_UPDATE_SCHEMA.properties,
          ...CONTACT_GET_SCHEMA.properties,
          ...CONTACT_LIST_SCHEMA.properties,
        },
        required: ['action'],
      },
      invoke: async (input) => {
        const action = (input as Record<string, unknown>).action as string;
        const userId = uid();
        if (!userId) return { error: 'Not authenticated' };

        return db.withPrincipalTx(async (q) => {
          if (action === 'create') {
            const { venture_id, name, email, phone, company, role } = input as Record<string, unknown>;
            const r = await q(
              `insert into ${db.schema}.contacts (user_id, venture_id, name, email, phone, company, role)
               values ($1, $2, $3, $4, $5, $6, $7) returning id, name, email, company, role, created_at`,
              [userId, venture_id, name, email || null, phone || null, company || null, role || null],
            );
            return r.rows[0] || { error: 'Failed to create contact' };
          } else if (action === 'update') {
            const { contact_id } = input as Record<string, unknown>;
            const ALLOWED_FIELDS = ['name', 'email', 'phone', 'company', 'role'];
            for (const field of Object.keys(input)) {
              if (!ALLOWED_FIELDS.includes(field) && field !== 'contact_id' && field !== 'action') {
                return { error: `Field '${field}' not allowed` };
              }
            }
            const updates: string[] = [];
            const values: unknown[] = [contact_id, userId];
            let paramIdx = 3;
            for (const field of ALLOWED_FIELDS) {
              const value = (input as Record<string, unknown>)[field];
              if (value !== undefined) {
                updates.push(`${field} = $${paramIdx}`);
                values.push(value);
                paramIdx++;
              }
            }
            if (updates.length === 0) return { error: 'No fields to update' };
            updates.push(`updated_at = now()`);
            const r = await q(
              `update ${db.schema}.contacts set ${updates.join(', ')}
               where id = $1 and user_id = $2 and deleted_at is null
               returning id, name, email, company, role, updated_at`,
              values,
            );
            return r.rows[0] || { error: 'Contact not found' };
          } else if (action === 'get') {
            const { contact_id } = input as Record<string, unknown>;
            const r = await q(
              `select id, name, email, phone, company, role, venture_id, created_at, updated_at from ${db.schema}.contacts
               where id = $1 and user_id = $2 and deleted_at is null`,
              [contact_id, userId],
            );
            return r.rows[0] || { error: 'Contact not found' };
          } else if (action === 'list') {
            const { venture_id } = input as Record<string, unknown>;
            const r = await q(
              `select id, name, email, company, role, venture_id from ${db.schema}.contacts
               where user_id = $1 and deleted_at is null ${venture_id ? 'and venture_id = $2' : ''}
               order by name`,
              venture_id ? [userId, venture_id] : [userId],
            );
            return { contacts: r.rows };
          }
          return { error: 'Invalid action' };
        });
      },
    },

    {
      name: 'crm_deal',
      description: 'Create, update, list, get, or move deals in the pipeline.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'update', 'list', 'get', 'move'], description: 'Action to perform.' },
          ...DEAL_CREATE_SCHEMA.properties,
          ...DEAL_UPDATE_SCHEMA.properties,
          ...DEAL_GET_SCHEMA.properties,
          ...DEAL_LIST_SCHEMA.properties,
          ...DEAL_MOVE_SCHEMA.properties,
        },
        required: ['action'],
      },
      invoke: async (input) => {
        const action = (input as Record<string, unknown>).action as string;
        const userId = uid();
        if (!userId) return { error: 'Not authenticated' };

        return db.withPrincipalTx(async (q) => {
          if (action === 'create') {
            const { venture_id, name, stage, contact_id, value_cents, currency } = input as Record<string, unknown>;
            const r = await q(
              `insert into ${db.schema}.deals (user_id, venture_id, name, stage, contact_id, value_cents, currency)
               values ($1, $2, $3, $4, $5, $6, $7) returning id, name, stage, value_cents, currency, created_at`,
              [userId, venture_id, name, stage, contact_id || null, value_cents || 0, currency || 'GBP'],
            );
            return r.rows[0] || { error: 'Failed to create deal' };
          } else if (action === 'update') {
            const { deal_id } = input as Record<string, unknown>;
            const ALLOWED_FIELDS = ['name', 'value_cents', 'currency', 'stage', 'contact_id', 'expected_close'];
            for (const field of Object.keys(input)) {
              if (!ALLOWED_FIELDS.includes(field) && field !== 'deal_id' && field !== 'action') {
                return { error: `Field '${field}' not allowed` };
              }
            }
            const updates: string[] = [];
            const values: unknown[] = [deal_id, userId];
            let paramIdx = 3;
            for (const field of ALLOWED_FIELDS) {
              const value = (input as Record<string, unknown>)[field];
              if (value !== undefined) {
                let finalValue = value;
                if (field === 'contact_id' || field === 'expected_close') {
                  finalValue = value === null ? null : value;
                }
                updates.push(`${field} = $${paramIdx}`);
                values.push(finalValue);
                paramIdx++;
              }
            }
            if (updates.length === 0) return { error: 'No fields to update' };
            updates.push(`updated_at = now()`);
            const r = await q(
              `update ${db.schema}.deals set ${updates.join(', ')}
               where id = $1 and user_id = $2 and deleted_at is null
               returning id, name, stage, value_cents, currency, updated_at`,
              values,
            );
            return r.rows[0] || { error: 'Deal not found' };
          } else if (action === 'get') {
            const { deal_id } = input as Record<string, unknown>;
            const r = await q(
              `select id, name, stage, value_cents, currency, contact_id, venture_id, expected_close, created_at, updated_at
               from ${db.schema}.deals where id = $1 and user_id = $2 and deleted_at is null`,
              [deal_id, userId],
            );
            return r.rows[0] || { error: 'Deal not found' };
          } else if (action === 'list') {
            const { venture_id, stage } = input as Record<string, unknown>;
            let query = `select id, name, stage, value_cents, currency, contact_id, venture_id from ${db.schema}.deals
                         where user_id = $1 and deleted_at is null`;
            const params: unknown[] = [userId];
            if (venture_id) {
              query += ` and venture_id = $${params.length + 1}`;
              params.push(venture_id);
            }
            if (stage) {
              query += ` and stage = $${params.length + 1}`;
              params.push(stage);
            }
            query += ` order by stage, position`;
            const r = await q(query, params);
            return { deals: r.rows };
          } else if (action === 'move') {
            const { deal_id, stage, position } = input as Record<string, unknown>;
            const deal = await q(
              `select venture_id, stage as current_stage from ${db.schema}.deals where id = $1 and user_id = $2 and deleted_at is null`,
              [deal_id, userId],
            );
            if (!deal.rows[0]) return { error: 'Deal not found' };
            const ventureId = (deal.rows[0] as Record<string, unknown>).venture_id as string;
            const currentStage = (deal.rows[0] as Record<string, unknown>).current_stage as string;

            let finalPosition = position as number | undefined;
            if (finalPosition === undefined || finalPosition === null) {
              const posRes = await q(
                `select coalesce(max(position), -1) as max_pos from ${db.schema}.deals
                 where user_id = $1 and venture_id = $2 and stage = $3 and deleted_at is null`,
                [userId, ventureId, stage],
              );
              const maxPos = (posRes.rows[0] as Record<string, unknown>)?.max_pos as number || -1;
              finalPosition = maxPos + 1;
            }

            const r = await q(
              `update ${db.schema}.deals set stage = $1, position = $2, updated_at = now()
               where id = $3 and user_id = $4 and venture_id = $5 and deleted_at is null
               returning id, name, stage, value_cents, currency, updated_at`,
              [stage, finalPosition, deal_id, userId, ventureId],
            );
            if (r.rows[0]) {
              await q(
                `insert into ${db.schema}.activities (user_id, venture_id, deal_id, kind, body, occurred_at)
                 values ($1, $2, $3, $4, $5, now())`,
                [userId, ventureId, deal_id, 'stage_change', `Moved from ${currentStage} to ${stage}`],
              );
            }
            return r.rows[0] || { error: 'Failed to move deal' };
          }
          return { error: 'Invalid action' };
        });
      },
    },

    {
      name: 'crm_activity',
      description: 'Log activities (calls, emails, notes, meetings) or list activities for a deal/contact.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['log', 'list'], description: 'Action to perform.' },
          ...ACTIVITY_LOG_SCHEMA.properties,
          ...ACTIVITY_LIST_SCHEMA.properties,
        },
        required: ['action'],
      },
      invoke: async (input) => {
        const action = (input as Record<string, unknown>).action as string;
        const userId = uid();
        if (!userId) return { error: 'Not authenticated' };

        return db.withPrincipalTx(async (q) => {
          if (action === 'log') {
            const { venture_id, kind, body, deal_id, contact_id } = input as Record<string, unknown>;
            const r = await q(
              `insert into ${db.schema}.activities (user_id, venture_id, kind, body, deal_id, contact_id, occurred_at)
               values ($1, $2, $3, $4, $5, $6, now()) returning id, kind, body, occurred_at, created_at`,
              [userId, venture_id, kind, body || null, deal_id || null, contact_id || null],
            );
            return r.rows[0] || { error: 'Failed to log activity' };
          } else if (action === 'list') {
            const { venture_id, deal_id, contact_id } = input as Record<string, unknown>;
            let query = `select id, kind, body, deal_id, contact_id, occurred_at from ${db.schema}.activities where user_id = $1 and venture_id = $2`;
            const params: unknown[] = [userId, venture_id];
            if (deal_id) {
              query += ` and deal_id = $${params.length + 1}`;
              params.push(deal_id);
            }
            if (contact_id) {
              query += ` and contact_id = $${params.length + 1}`;
              params.push(contact_id);
            }
            query += ` order by occurred_at desc`;
            const r = await q(query, params);
            return { activities: r.rows };
          }
          return { error: 'Invalid action' };
        });
      },
    },
  ];
}
