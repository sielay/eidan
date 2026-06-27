// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NextRequest } from "next/server";
import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

interface FsNode {
  id: string;
  parent_id: string | null;
  kind: string;
  name: string;
  storage_kind: string;
  mime: string | null;
  size_bytes: number | null;
  storage_ref: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

type FsNodePartial = { id: string; name: string; kind: string };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const parentId = req.nextUrl.searchParams.get("parent");
  const tag = (req.nextUrl.searchParams.get("tag") ?? "").trim();

  const payload = await withUser(sess.userId, async (c) => {
    // A `tag` filter searches the user's whole tree (ignores parent); otherwise list one folder.
    const params: unknown[] = [sess.userId];
    let where = "user_id = $1 and status = 'active'";
    if (tag) { params.push(JSON.stringify([tag])); where += ` and coalesce(metadata->'tags','[]'::jsonb) @> $${params.length}::jsonb`; }
    else if (parentId) { params.push(parentId); where += ` and parent_id = $${params.length}`; }
    else { where += " and parent_id is null"; }
    const r = await c.query(
      `select id, parent_id, kind, name, storage_kind, mime, size_bytes, created_at,
              coalesce(metadata->'tags','[]'::jsonb) as tags
         from plugin_fs.fs_nodes
        where ${where}
        order by kind desc, name`,
      params,
    );
    const nodes = (r.rows as Array<FsNode & { tags?: unknown }>).map((row) => ({
      id: row.id,
      parent_id: row.parent_id,
      kind: row.kind,
      name: row.name,
      storage_kind: row.storage_kind,
      mime: row.mime,
      size_bytes: row.size_bytes,
      created_at: row.created_at,
      tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    }));
    return { nodes };
  });

  return Response.json(payload);
}

export async function POST(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const action = typeof body["action"] === "string" ? body["action"].trim() : "";
  if (action === "tag") {
    const ids = Array.isArray(body["ids"]) ? (body["ids"] as unknown[]).filter((x): x is string => typeof x === "string") : [];
    const norm = (v: unknown): string[] => Array.isArray(v) ? Array.from(new Set((v as unknown[]).filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean))) : [];
    const add = norm(body["add"]);
    const remove = norm(body["remove"]);
    if (!ids.length || (!add.length && !remove.length)) return Response.json({ error: "ids and add/remove required" }, { status: 400 });
    const updated = await withUser(sess.userId, async (c) => {
      let n = 0;
      for (const id of ids) {
        const cur = await c.query("select coalesce(metadata->'tags','[]'::jsonb) as tags from plugin_fs.fs_nodes where id=$1 and user_id=$2 and status='active'", [id, sess.userId]);
        const row = cur.rows[0] as { tags?: unknown } | undefined;
        if (!row) continue;
        let tags = Array.isArray(row.tags) ? row.tags.map(String) : [];
        if (add.length) tags = Array.from(new Set([...tags, ...add]));
        if (remove.length) tags = tags.filter((t) => !remove.includes(t));
        await c.query("update plugin_fs.fs_nodes set metadata = jsonb_set(coalesce(metadata,'{}'::jsonb), '{tags}', $2::jsonb, true), updated_at=now() where id=$1 and user_id=$3", [id, JSON.stringify(tags), sess.userId]);
        n++;
      }
      return n;
    });
    return Response.json({ ok: true, updated });
  }
  if (action === "mkdir") {
    const name = typeof body["name"] === "string" ? body["name"].trim() : "";
    const parentId = typeof body["parent_id"] === "string" ? body["parent_id"] : null;
    if (!name) return Response.json({ error: "name is required" }, { status: 400 });

    try {
      const node = await withUser(sess.userId, async (c) => {
        const r = await c.query(
          `insert into plugin_fs.fs_nodes
              (user_id, parent_id, kind, name, storage_kind)
           values ($1, $2, 'folder', $3, 'virtual')
           returning id, name, kind`,
          [sess.userId, parentId, name],
        );
        return r.rows[0] as FsNodePartial;
      });
      return Response.json({ ok: true, node }, { status: 201 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/unique/i.test(msg)) return Response.json({ error: "folder already exists" }, { status: 409 });
      return Response.json({ error: msg }, { status: 400 });
    }
  }

  return Response.json({ error: "unknown action" }, { status: 400 });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const action = typeof body["action"] === "string" ? body["action"].trim() : "";
  const id = typeof body["id"] === "string" ? body["id"].trim() : "";
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  if (action === "rename") {
    const newName = typeof body["name"] === "string" ? body["name"].trim() : "";
    if (!newName) return Response.json({ error: "name is required" }, { status: 400 });

    try {
      await withUser(sess.userId, async (c) => {
        await c.query(
          `update plugin_fs.fs_nodes set name = $1, updated_at = now() where id = $2 and user_id = $3`,
          [newName, id, sess.userId],
        );
      });
      return Response.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: msg }, { status: 400 });
    }
  }

  if (action === "move") {
    const newParentId = typeof body["parent_id"] === "string" ? body["parent_id"] : null;

    try {
      await withUser(sess.userId, async (c) => {
        await c.query(
          `update plugin_fs.fs_nodes set parent_id = $1, updated_at = now() where id = $2 and user_id = $3`,
          [newParentId, id, sess.userId],
        );
      });
      return Response.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: msg }, { status: 400 });
    }
  }

  return Response.json({ error: "unknown action" }, { status: 400 });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  try {
    await withUser(sess.userId, async (c) => {
      await c.query(
        `with recursive archive_tree as (
           select id from plugin_fs.fs_nodes where id = $1 and user_id = $2
           union all
           select n.id from plugin_fs.fs_nodes n
           inner join archive_tree a on n.parent_id = a.id
         )
         update plugin_fs.fs_nodes
            set status = 'archived', updated_at = now()
          where id in (select id from archive_tree)`,
        [id, sess.userId],
      );
    });
    return Response.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 400 });
  }
}
