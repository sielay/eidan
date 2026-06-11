// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/commands — plugin slash-commands registered at activation. This is engine runtime state
// (not a DB table); until the engine exposes it, the catalogue is empty (the palette still has its
// built-in commands). Returns 200 so the Cmd-K palette renders rather than erroring.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  return Response.json({ commands: [] });
}
