// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NextRequest } from 'next/server';
import { verifyBearer } from '@/server/auth';
import { withUser } from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ActivityRow {
  id: string;
  kind: string;
  body?: string;
  deal_id?: string;
  contact_id?: string;
  occurred_at: string;
}

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response('unauthorized', { status: 401 });

  const dealId = req.nextUrl.searchParams.get('deal_id');
  const contactId = req.nextUrl.searchParams.get('contact_id');
  const ventureId = req.nextUrl.searchParams.get('venture_id');
  if (!dealId && !contactId) return Response.json({ error: 'deal_id or contact_id required' }, { status: 400 });

  const payload = await withUser(sess.userId, async (c) => {
    let query = `select id, kind, body, deal_id, contact_id, occurred_at
                   from plugin_crm.activities
                  where user_id = $1 and venture_id = $2`;
    const params: unknown[] = [sess.userId, ventureId];
    if (dealId) {
      query += ` and deal_id = $${params.length + 1} and exists (select 1 from plugin_crm.deals d where d.id = $${params.length + 1} and d.user_id = $1)`;
      params.push(dealId);
    } else if (contactId) {
      query += ` and contact_id = $${params.length + 1} and exists (select 1 from plugin_crm.contacts ct where ct.id = $${params.length + 1} and ct.user_id = $1)`;
      params.push(contactId);
    }
    query += ` order by occurred_at desc`;
    const r = await c.query(query, params);
    return { activities: r.rows as ActivityRow[] };
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

  const { venture_id, kind, description, deal_id, contact_id } = body;
  if (!venture_id || !kind) return Response.json({ error: 'venture_id and kind required' }, { status: 400 });

  const payload = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `insert into plugin_crm.activities (user_id, venture_id, kind, body, deal_id, contact_id, occurred_at)
       values ($1, $2, $3, $4, $5, $6, now())
       returning id, kind, body, deal_id, contact_id, occurred_at, created_at`,
      [sess.userId, venture_id, kind, description || null, deal_id || null, contact_id || null],
    );
    return r.rows[0] || { error: 'Failed to log activity' };
  });

  return Response.json(payload, { status: 201 });
}
