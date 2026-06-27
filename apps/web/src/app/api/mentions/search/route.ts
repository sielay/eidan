// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/mentions/search?q=&types= — the @-mention autocomplete source. Aggregates the things you
// can reference in any markdown we edit (chat, file specs, personas, the system prompt): files,
// folders, agents, ventures, assets. Each hit is { type, id, label, hint }; the editor inserts a
// resolvable token `@[label](eidan:type:id)` that the engine expands at turn time (see frontend-agui).
// Owner-scoped (every query filters user_id). Optional bundles (ventures/assets) are resilient — a
// missing plugin_ventures schema just yields no rows of that type rather than failing the whole search.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface MentionHit {
  type: "file" | "folder" | "agent" | "venture" | "asset";
  id: string;
  label: string;
  hint: string;
}

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  const typesParam = (req.nextUrl.searchParams.get("types") ?? "").trim();
  const wanted = typesParam ? new Set(typesParam.split(",").map((s) => s.trim())) : null;
  const want = (t: string): boolean => !wanted || wanted.has(t);
  if (!q) return Response.json({ items: [] });
  const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  const uid = sess.userId;
  const items: MentionHit[] = [];

  // Core (always present): files/folders in the virtual FS + the user's agents.
  try {
    const core = await withUser(uid, async (c) => {
      const files = (want("file") || want("folder"))
        ? await c.query(
            `select id, name, kind from plugin_fs.fs_nodes
              where user_id = $1 and status = 'active' and name ilike $2
              order by (kind = 'folder') desc, name limit 8`,
            [uid, like],
          )
        : { rows: [] as Array<Record<string, unknown>> };
      const agents = want("agent")
        ? await c.query(
            `select id, coalesce(nullif(display_name, ''), name) as label, description
               from eidan.agents
              where user_id = $1 and deleted_at is null
                and (name ilike $2 or coalesce(display_name, '') ilike $2 or coalesce(slug, '') ilike $2)
              order by label limit 6`,
            [uid, like],
          )
        : { rows: [] as Array<Record<string, unknown>> };
      return { files: files.rows, agents: agents.rows };
    });
    for (const f of core.files) {
      const kind = f["kind"] === "folder" ? "folder" : "file";
      if (want(kind)) items.push({ type: kind, id: String(f["id"]), label: String(f["name"]), hint: kind });
    }
    for (const a of core.agents) items.push({ type: "agent", id: String(a["id"]), label: String(a["label"]), hint: typeof a["description"] === "string" && a["description"] ? String(a["description"]).slice(0, 60) : "agent" });
  } catch {
    /* core tables should exist; on any error just return what we have */
  }

  // Optional (the ventures bundle): ventures + their assets (resources). Skipped if not installed.
  if (want("venture") || want("asset")) {
    try {
      const v = await withUser(uid, async (c) => {
        const ventures = want("venture")
          ? await c.query(
              `select id, name from plugin_ventures.ventures
                where user_id = $1 and coalesce(status, '') <> 'archived' and name ilike $2
                order by name limit 6`,
              [uid, like],
            )
          : { rows: [] as Array<Record<string, unknown>> };
        const assets = want("asset")
          ? await c.query(
              `select id, coalesce(nullif(label, ''), kind) as label, kind
                 from plugin_ventures.venture_resources
                where user_id = $1 and coalesce(nullif(label, ''), kind) ilike $2
                order by label limit 6`,
              [uid, like],
            )
          : { rows: [] as Array<Record<string, unknown>> };
        return { ventures: ventures.rows, assets: assets.rows };
      });
      for (const vv of v.ventures) items.push({ type: "venture", id: String(vv["id"]), label: String(vv["name"]), hint: "venture" });
      for (const a of v.assets) items.push({ type: "asset", id: String(a["id"]), label: String(a["label"]), hint: String(a["kind"]) });
    } catch {
      /* ventures bundle not installed on this node — skip silently */
    }
  }

  return Response.json({ items: items.slice(0, 24) });
}
