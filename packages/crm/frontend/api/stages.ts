// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NextRequest } from 'next/server';
import { verifyBearer } from '@/server/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response('unauthorized', { status: 401 });

  // Return default stages. Stages are global, not per-venture.
  const stages = ['lead', 'qualified', 'proposal', 'won', 'lost'];
  const terminalStages = ['won', 'lost'];

  return Response.json({ stages, terminalStages });
}
