// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/admin/panels — operator-declared plugin admin panels. Core stays plugin-agnostic: the
// gitignored EIDAN_ADMIN_PANELS env names the prefixes the dashboard probes for loop summaries
// (e.g. "sage=/api/sage"). Unset → []. (The dedicated cursors tab was removed; the dashboard still
// surfaces any configured panel summaries.)
import type { NextRequest } from "next/server";

import { parsePanels } from "@/lib/admin-panels";
import { verifyBearer } from "@/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  return Response.json({ panels: parsePanels(process.env.EIDAN_ADMIN_PANELS) });
}
