// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/admin/panels — plugin-contributed cursor panels (managed-item loops, e.g. Sage). These
// are plugin runtime state, not a DB table; until a plugin registers panels via the engine this is
// empty. Returns 200 so the admin dashboard renders rather than erroring.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  return Response.json({ panels: [] });
}
