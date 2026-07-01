// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { authFetch } from "@/lib/auth";

/** A conversation folder (eidan.conversation_folders). `parent_id` nests folders; null = top level. */
export interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  starred: boolean;
  sort_order: number;
  created_at?: string;
  updated_at?: string;
}

export async function listFolders(): Promise<Folder[]> {
  const res = await authFetch("/api/folders", { method: "GET", headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`GET /api/folders returned ${res.status}`);
  return ((await res.json()) as { folders?: Folder[] }).folders ?? [];
}

export async function createFolder(name: string, parentId?: string | null): Promise<Folder> {
  const res = await authFetch("/api/folders", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ name, ...(parentId ? { parent_id: parentId } : {}) }),
  });
  if (!res.ok) throw new Error(`POST /api/folders returned ${res.status}`);
  return ((await res.json()) as { folder: Folder }).folder;
}

export async function updateFolder(
  id: string,
  patch: { name?: string; starred?: boolean; parent_id?: string | null; sort_order?: number },
): Promise<Folder> {
  const res = await authFetch(`/api/folders/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`PATCH /api/folders/${id} returned ${res.status}`);
  return ((await res.json()) as { folder: Folder }).folder;
}

/** Delete a folder: its conversations move to root and child folders reparent to its parent. */
export async function deleteFolder(id: string): Promise<void> {
  const res = await authFetch(`/api/folders/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`DELETE /api/folders/${id} returned ${res.status}`);
}
