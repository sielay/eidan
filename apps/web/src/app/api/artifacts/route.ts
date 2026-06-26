// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/artifacts — list the owner's stored files (eidan.artifacts): everything the agent writes
// via matbot's `workspace_action` scratch store plus generated artifacts (rendered decks, etc.). The
// per-file bytes are served by /api/artifacts/[id]; this is just the index the Workspace screen lists
// so files an agent creates are actually findable in the UI. Owner-scoped, bearer-auth.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ArtifactRow {
  id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  kind: string | null;
  namespace: string | null;
  conversation_id: string | null;
  created_at: string;
  updated_at: string | null;
}

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const files = await withUser(sess.userId, async (c) => {
    const r = await c.query(
      `select id, filename, mime_type, size_bytes, kind,
              metadata->>'namespace' as namespace, conversation_id,
              created_at, updated_at
         from eidan.artifacts
        where user_id = $1 and deleted_at is null
        order by coalesce(updated_at, created_at) desc
        limit 500`,
      [sess.userId],
    );
    return r.rows as ArtifactRow[];
  });

  return Response.json({ files });
}
