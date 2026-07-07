// SPDX-License-Identifier: AGPL-3.0-or-later
// One uploader for the whole UI. When object storage (S3) is configured, it uploads the file DIRECTLY
// to the bucket via a presigned URL — the bytes never touch the Next/Vercel function, so video-sized
// files sail past the ~4.5MB serverless body cap. When S3 isn't configured (or presign declines), it
// falls back to the multipart /api/fs/file path (small files → Postgres bytea). Callers don't care
// which path ran; they get back the created fs node. `onProgress` reports 0..1 for the direct path.
import { authFetch } from "@/lib/auth";

export interface UploadedNode { id: string; name: string; mime?: string; size_bytes?: number; storage_kind?: string }

interface PresignResp { direct: boolean; node_id?: string; upload_url?: string; storage_kind?: string; reason?: string }

// PUT the file straight to the presigned URL with progress (fetch has no upload progress, so XHR).
function putWithProgress(url: string, file: File, onProgress?: (frac: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    if (file.type) xhr.setRequestHeader("content-type", file.type);
    xhr.upload.onprogress = (e) => { if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`direct upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error("direct upload network error (check bucket CORS for this origin)"));
    xhr.send(file);
  });
}

export async function uploadFile(
  file: File,
  opts: { parentId?: string | null; onProgress?: (frac: number) => void } = {},
): Promise<UploadedNode> {
  const parentId = opts.parentId ?? null;

  // 1) Try a presigned direct-to-S3 upload (the default whenever S3 is enabled).
  try {
    const pre = await authFetch("/api/fs/presign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: file.name, mime: file.type || "application/octet-stream", parent_id: parentId }),
    });
    if (pre.ok) {
      const j = (await pre.json()) as PresignResp;
      if (j.direct && j.upload_url && j.node_id) {
        await putWithProgress(j.upload_url, file, opts.onProgress);
        const fin = await authFetch("/api/fs/finalize", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ node_id: j.node_id }),
        });
        const fj = (await fin.json().catch(() => ({}))) as { node?: UploadedNode; error?: string };
        if (!fin.ok || !fj.node) throw new Error(fj.error || "finalize failed");
        opts.onProgress?.(1);
        return fj.node;
      }
    }
  } catch (err) {
    // Presign/direct path failed (S3 misconfig, CORS). Only retry via multipart for SMALL files —
    // large files would just hit the Vercel cap on the fallback too, so surface the real error.
    if (file.size >= 4 * 1024 * 1024) throw err instanceof Error ? err : new Error(String(err));
  }

  // 2) Fallback: multipart through the app (small files, or S3 not configured).
  const fd = new FormData();
  fd.append("file", file);
  if (parentId) fd.append("parent_id", parentId);
  const r = await authFetch("/api/fs/file", { method: "POST", body: fd });
  const rj = (await r.json().catch(() => ({}))) as { node?: UploadedNode; error?: string };
  if (!r.ok || !rj.node) throw new Error(rj.error || "upload failed");
  opts.onProgress?.(1);
  return rj.node;
}
