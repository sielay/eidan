// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/admin/panels — plugin-contributed cursor panels (managed-item loops, e.g. a PR-review
// loop). These are plugin runtime state, not a DB table. The operator declares which plugin route
// prefixes expose the cursors/summary convention via the gitignored env var EIDAN_ADMIN_PANELS, so
// core stays plugin-agnostic (no bundle named in tracked source). The UI probes each prefix and
// silently drops any that don't implement the shape, so a stale entry is harmless.
//
//   EIDAN_ADMIN_PANELS="sage=/api/sage, business=/api/charles"
//   (or bare prefixes: "/api/sage" → name derived from the last path segment)
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
