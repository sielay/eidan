// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NextRequest } from 'next/server';
import { verifyBearer } from '@/server/auth';
import { withUser } from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PipelineColumn {
  stage: string;
  deals: Array<{ id: string; name: string; contact_name?: string; company?: string; value_cents: number; currency: string }>;
  total_cents: number;
  count: number;
}

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response('unauthorized', { status: 401 });

  const ventureId = req.nextUrl.searchParams.get('venture_id');
  if (!ventureId) return Response.json({ error: 'venture_id required' }, { status: 400 });

  const payload = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select d.id, d.name, d.stage, d.value_cents, d.currency, d.position,
              ct.name as contact_name, ct.company
         from plugin_crm.deals d
         left join plugin_crm.contacts ct on d.contact_id = ct.id
        where d.user_id = $1 and d.venture_id = $2 and d.deleted_at is null
        order by d.stage, d.position`,
      [sess.userId, ventureId],
    );

    const stages = new Map<string, PipelineColumn>();
    for (const row of r.rows as Array<{ id: string; name: string; stage: string; value_cents: number; currency: string; position: number; contact_name?: string; company?: string }>) {
      if (!stages.has(row.stage)) {
        stages.set(row.stage, { stage: row.stage, deals: [], total_cents: 0, count: 0 });
      }
      const col = stages.get(row.stage)!;
      col.deals.push({
        id: row.id,
        name: row.name,
        contact_name: row.contact_name,
        company: row.company,
        value_cents: row.value_cents,
        currency: row.currency,
      });
      col.total_cents += row.value_cents;
      col.count += 1;
    }

    return { columns: Array.from(stages.values()) };
  });

  return Response.json(payload);
}
