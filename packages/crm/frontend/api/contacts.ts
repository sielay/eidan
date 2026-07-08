// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NextRequest } from 'next/server';
import { verifyBearer } from '@/server/auth';
import { withUser } from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ContactRow {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  role?: string;
  venture_id: string;
}

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response('unauthorized', { status: 401 });

  const ventureId = req.nextUrl.searchParams.get('venture_id');
  if (!ventureId) return Response.json({ error: 'venture_id required' }, { status: 400 });

  const payload = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select id, name, email, phone, company, role, venture_id
         from plugin_crm.contacts
        where user_id = $1 and venture_id = $2 and deleted_at is null
        order by name`,
      [sess.userId, ventureId],
    );
    return { contacts: r.rows as ContactRow[] };
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

  const { venture_id, name, email, phone, company, role } = body;
  if (!venture_id || !name) return Response.json({ error: 'venture_id and name required' }, { status: 400 });

  const payload = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `insert into plugin_crm.contacts (user_id, venture_id, name, email, phone, company, role)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, name, email, phone, company, role, venture_id, created_at`,
      [sess.userId, venture_id, name, email || null, phone || null, company || null, role || null],
    );
    return r.rows[0] || { error: 'Failed to create contact' };
  });

  return Response.json(payload, { status: 201 });
}
