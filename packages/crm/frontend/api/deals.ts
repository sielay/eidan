// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NextRequest } from 'next/server';
import { verifyBearer } from '@/server/auth';
import { withUser } from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DealRow {
  id: string;
  name: string;
  stage: string;
  value_cents: number;
  currency: string;
  contact_id?: string;
  venture_id: string;
  expected_close?: string;
  position: number;
}

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response('unauthorized', { status: 401 });

  const ventureId = req.nextUrl.searchParams.get('venture_id');
  const stage = req.nextUrl.searchParams.get('stage');
  if (!ventureId) return Response.json({ error: 'venture_id required' }, { status: 400 });

  const payload = await withUser(sess.userId, async (c) => {
    let query = `select id, name, stage, value_cents, currency, contact_id, venture_id, expected_close, position
                   from plugin_crm.deals
                  where user_id = $1 and venture_id = $2 and deleted_at is null`;
    const params: unknown[] = [sess.userId, ventureId];
    if (stage) {
      query += ` and stage = $3`;
      params.push(stage);
    }
    query += ` order by stage, position`;
    const r = await c.query(query, params);
    return { deals: r.rows as DealRow[] };
  });

  return Response.json(payload);
}

export async function POST(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response('unauthorized', { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { venture_id, name, stage, contact_id, value_cents, currency } = body;
  if (!venture_id || !name || !stage) return Response.json({ error: 'venture_id, name, and stage required' }, { status: 400 });

  const payload = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `insert into plugin_crm.deals (user_id, venture_id, name, stage, contact_id, value_cents, currency)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, name, stage, value_cents, currency, contact_id, venture_id, created_at`,
      [sess.userId, venture_id, name, stage, contact_id || null, value_cents || 0, currency || 'GBP'],
    );
    return r.rows[0] || { error: 'Failed to create deal' };
  });

  return Response.json(payload, { status: 201 });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response('unauthorized', { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { deal_id, stage, venture_id } = body;
  if (!deal_id || !stage) return Response.json({ error: 'deal_id and stage required' }, { status: 400 });

  // Whitelist allowed fields for update. Position is managed by backend logic only.
  const allowedFields = ['stage'];
  for (const field of Object.keys(body)) {
    if (!allowedFields.includes(field as string) && field !== 'deal_id' && field !== 'venture_id') {
      return Response.json({ error: `Field '${field}' not allowed` }, { status: 400 });
    }
  }

  const deal = await withUser(sess.userId, async (c) => {
    const result = await c.query(
      `select venture_id, stage as current_stage from plugin_crm.deals where id = $1 and user_id = $2 and deleted_at is null`,
      [deal_id, sess.userId],
    );
    return result.rows[0] as Record<string, unknown> | undefined;
  });

  if (!deal) {
    return Response.json({ error: 'Deal not found' }, { status: 404 });
  }

  const dealVentureId = deal.venture_id as string;
  const currentStage = deal.current_stage as string;

  // Validate that the deal belongs to the requested venture. If venture_id is provided, it must match.
  // Either way, the UPDATE query will re-verify using the deal's actual venture_id.
  if (venture_id && dealVentureId !== venture_id) {
    return Response.json({ error: 'Deal does not belong to the specified venture' }, { status: 403 });
  }

  const payload = await withUser(sess.userId, async (c) => {
    // Position is always computed by the backend for ordering within a stage.
    // Append-only model: deals in a stage get max(position) + 1 to avoid re-ordering all deals on move.
    const posRes = await c.query(
      `select coalesce(max(position), -1) as max_pos from plugin_crm.deals where user_id = $1 and venture_id = $2 and stage = $3 and deleted_at is null`,
      [sess.userId, dealVentureId, stage],
    );
    const maxPos = (posRes.rows[0] as Record<string, unknown>)?.max_pos as number || -1;
    const newPosition = maxPos + 1;

    const r = await c.query(
      `update plugin_crm.deals set stage = $1, position = $2, updated_at = now()
       where id = $3 and user_id = $4 and venture_id = $5 and deleted_at is null
       returning id, name, stage, value_cents, currency, updated_at`,
      [stage, newPosition, deal_id, sess.userId, dealVentureId],
    );
    if (r.rows[0] && stage !== currentStage) {
      await c.query(
        `insert into plugin_crm.activities (user_id, venture_id, deal_id, kind, body, occurred_at)
         values ($1, $2, $3, $4, $5, now())`,
        [sess.userId, dealVentureId, deal_id, 'stage_change', `Moved from ${currentStage} to ${stage}`],
      );
    }
    return r.rows[0] || { error: 'Failed to move deal' };
  });

  if (payload && typeof payload === 'object' && 'error' in payload) {
    return Response.json(payload, { status: 500 });
  }
  return Response.json(payload);
}
