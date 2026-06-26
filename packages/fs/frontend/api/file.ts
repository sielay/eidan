// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NextRequest } from "next/server";
import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

type FsNodePartial = { id: string; name: string };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "50mb",
    },
  },
};

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });

  try {
    const result = await withUser(sess.userId, async (c) => {
      const nodeRes = await c.query(
        `select id, name, mime, storage_kind, storage_ref from plugin_fs.fs_nodes where id = $1 and user_id = $2 and kind = 'file'`,
        [id, sess.userId],
      );
      if (!nodeRes.rows.length) return null;
      const node = nodeRes.rows[0] as Record<string, unknown>;
      // Local (pg bytea) is served directly here; offloaded / Drive files are served by the engine's
      // /api/fs/blob (it resolves storage creds from the vault, which the web can't read).
      if (node["storage_kind"] !== "local") throw new Error("read this file via /api/fs/blob");

      const blobRes = await c.query(
        `select data from plugin_fs.fs_blobs where node_id = $1 and user_id = $2`,
        [id, sess.userId],
      );
      if (!blobRes.rows.length) throw new Error("blob not found");
      const blob = blobRes.rows[0] as { data: Buffer };
      return { name: node["name"], mime: node["mime"], bytes: new Uint8Array(blob.data.buffer, blob.data.byteOffset, blob.data.byteLength) };
    });

    if (!result) return Response.json({ error: "file not found" }, { status: 404 });

    const { name, mime, bytes } = result;
    return new Response(bytes as unknown as BodyInit, {
      headers: {
        "content-type": (mime as string) || "application/octet-stream",
        "content-disposition": `attachment; filename="${encodeURIComponent(String(name))}"`,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 400 });
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  try {
    const contentType = req.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const body = (await req.json()) as Record<string, unknown>;
      const name = typeof body["name"] === "string" ? body["name"].trim() : "";
      const parentId = typeof body["parent_id"] === "string" ? body["parent_id"] : null;
      const content = typeof body["content"] === "string" ? body["content"] : "";
      const mime = typeof body["mime"] === "string" ? body["mime"] : "text/plain";

      if (!name) return Response.json({ error: "name is required" }, { status: 400 });

      const bytes = new TextEncoder().encode(content);
      const node = await withUser(sess.userId, async (c) => {
        const r = await c.query(
          `insert into plugin_fs.fs_nodes
              (user_id, parent_id, kind, name, storage_kind, mime, size_bytes)
           values ($1, $2, 'file', $3, 'local', $4, $5)
           returning id, name`,
          [sess.userId, parentId, name, mime, bytes.length],
        );
        const nodeId = (r.rows[0] as FsNodePartial).id;
        await c.query(
          `insert into plugin_fs.fs_blobs (node_id, user_id, data) values ($1, $2, $3)`,
          [nodeId, sess.userId, bytes],
        );
        return r.rows[0] as FsNodePartial;
      });

      return Response.json({ ok: true, node }, { status: 201 });
    } else if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      const file = formData.get("file") as File | null;
      const parentId = (formData.get("parent_id") as string) || null;

      if (!file) return Response.json({ error: "file is required" }, { status: 400 });

      const bytes = new Uint8Array(await file.arrayBuffer());
      const node = await withUser(sess.userId, async (c) => {
        const r = await c.query(
          `insert into plugin_fs.fs_nodes
              (user_id, parent_id, kind, name, storage_kind, mime, size_bytes)
           values ($1, $2, 'file', $3, 'local', $4, $5)
           returning id, name`,
          [sess.userId, parentId, file.name, file.type || "application/octet-stream", bytes.length],
        );
        const nodeId = (r.rows[0] as FsNodePartial).id;
        await c.query(
          `insert into plugin_fs.fs_blobs (node_id, user_id, data) values ($1, $2, $3)`,
          [nodeId, sess.userId, bytes],
        );
        return r.rows[0] as FsNodePartial;
      });

      return Response.json({ ok: true, node }, { status: 201 });
    } else {
      return Response.json({ error: "content-type must be application/json or multipart/form-data" }, { status: 400 });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 400 });
  }
}
