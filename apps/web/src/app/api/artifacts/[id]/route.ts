// SPDX-License-Identifier: AGPL-3.0-or-later
// Serve an agent-produced artifact (e.g. a rendered deck) to its owner. Reads eidan.artifacts +
// eidan.artifact_blobs (owner-scoped, bearer-auth). Text/PDF are returned inline so the browser
// previews them (an HTML deck opens as slides in a new tab); everything else downloads. The client
// fetches with its bearer and opens the bytes via an object URL — so no public/un-authed URL exists.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });
  const id = req.nextUrl.pathname.split("/").filter(Boolean).pop() ?? "";
  if (!id) return new Response("id required", { status: 400 });

  // Resolve from the legacy artifacts store first, then the unified fs (plugin_fs) — so old chat
  // download-chips (artifact ids) and new ones (fs node ids) both serve through this one route.
  const row = await withUser(sess.userId, async (c) => {
    const a = await c.query(
      `select a.filename, a.mime_type, b.data
         from eidan.artifacts a
         join eidan.artifact_blobs b on b.artifact_id = a.id
        where a.id = $1 and a.user_id = $2 and a.deleted_at is null`,
      [id, sess.userId],
    );
    if (a.rows.length) return a.rows[0] as { filename: string; mime_type: string; data: Buffer };
    const f = await c.query(
      `select n.name as filename, n.mime as mime_type, b.data
         from plugin_fs.fs_nodes n
         join plugin_fs.fs_blobs b on b.node_id = n.id
        where n.id = $1 and n.user_id = $2 and n.kind = 'file' and n.status = 'active'`,
      [id, sess.userId],
    );
    return f.rows[0] as { filename: string; mime_type: string; data: Buffer } | undefined;
  });
  if (!row) return new Response("not found", { status: 404 });

  const mime = row.mime_type || "application/octet-stream";
  const inline = mime.startsWith("text/") || mime === "application/pdf" || mime.startsWith("image/");
  const safeName = row.filename.replace(/[\r\n"]/g, "");
  const bytes = new Uint8Array(row.data.buffer, row.data.byteOffset, row.data.byteLength);
  // The DOM BodyInit type narrows ArrayBufferView to ArrayBuffer-backed; a Buffer-backed Uint8Array is
  // a valid body at runtime, so cast past the (ArrayBufferLike) variance quibble.
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "content-type": mime,
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${safeName}"`,
      "cache-control": "private, no-store",
    },
  });
}
