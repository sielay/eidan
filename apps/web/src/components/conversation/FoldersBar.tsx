// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { type Folder, createFolder, updateFolder, deleteFolder } from "@/lib/api/folders";
import { cn } from "@/lib/utils";

/** The selected folder filter: a folder id, "none" (unfiled), or null (all conversations). */
export type FolderFilter = string | "none" | null;

interface FoldersBarProps {
  folders: Folder[];
  selected: FolderFilter;
  onSelect: (f: FolderFilter) => void;
  /** Re-fetch folders after a create/rename/delete/star. */
  onChanged: () => void;
}

export function FoldersBar({ folders, selected, onSelect, onChanged }: FoldersBarProps): React.ReactElement {
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const create = React.useCallback(async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const f = await createFolder(name);
      setNewName("");
      setCreating(false);
      onChanged();
      onSelect(f.id);
    } catch {
      /* leave the input open so the user can retry */
    } finally {
      setBusy(false);
    }
  }, [newName, busy, onChanged, onSelect]);

  return (
    <div className="flex flex-col gap-0.5 px-1 py-1">
      <div className="flex items-center gap-1">
        <FolderPill label="All" active={selected === null} onClick={() => onSelect(null)} />
        <FolderPill label="Unfiled" active={selected === "none"} onClick={() => onSelect("none")} />
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          title="New folder"
          className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          + Folder
        </button>
      </div>

      {creating ? (
        <div className="flex items-center gap-1 px-1 py-1">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void create(); if (e.key === "Escape") { setCreating(false); setNewName(""); } }}
            placeholder="Folder name"
            className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-0.5 text-xs"
          />
          <button type="button" onClick={() => void create()} disabled={busy || !newName.trim()} className="rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-accent disabled:opacity-50">Add</button>
        </div>
      ) : null}

      {folders.length > 0 ? (
        <ul className="flex flex-col">
          {folders.map((f) => (
            <FolderRow
              key={f.id}
              folder={f}
              active={selected === f.id}
              onSelect={() => onSelect(f.id)}
              onChanged={onChanged}
              clearSelectionIfActive={() => { if (selected === f.id) onSelect(null); }}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function FolderPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded px-2 py-0.5 text-[11px]",
        active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function FolderRow({
  folder,
  active,
  onSelect,
  onChanged,
  clearSelectionIfActive,
}: {
  folder: Folder;
  active: boolean;
  onSelect: () => void;
  onChanged: () => void;
  clearSelectionIfActive: () => void;
}): React.ReactElement {
  const [renaming, setRenaming] = React.useState(false);
  const [name, setName] = React.useState(folder.name);
  const [busy, setBusy] = React.useState(false);

  const rename = React.useCallback(async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    try { await updateFolder(folder.id, { name: n }); setRenaming(false); onChanged(); }
    catch { /* keep editing */ } finally { setBusy(false); }
  }, [name, busy, folder.id, onChanged]);

  const toggleStar = React.useCallback(async () => {
    try { await updateFolder(folder.id, { starred: !folder.starred }); onChanged(); } catch { /* noop */ }
  }, [folder.id, folder.starred, onChanged]);

  const remove = React.useCallback(async () => {
    if (typeof window !== "undefined" && !window.confirm(`Delete folder "${folder.name}"? Its chats move to Unfiled.`)) return;
    try { await deleteFolder(folder.id); clearSelectionIfActive(); onChanged(); } catch { /* noop */ }
  }, [folder.id, folder.name, clearSelectionIfActive, onChanged]);

  if (renaming) {
    return (
      <li className="flex items-center gap-1 px-1 py-0.5">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void rename(); if (e.key === "Escape") { setRenaming(false); setName(folder.name); } }}
          className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-0.5 text-xs"
        />
        <button type="button" onClick={() => void rename()} disabled={busy} className="rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-accent disabled:opacity-50">Save</button>
      </li>
    );
  }

  return (
    <li
      className={cn(
        "group flex items-center gap-1 rounded px-1 py-0.5 text-xs",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
    >
      <button type="button" onClick={() => void toggleStar()} title={folder.starred ? "Unstar folder" : "Star folder"} className="text-[11px] leading-none">
        <span className={folder.starred ? "text-amber-500" : "text-muted-foreground/50 group-hover:text-muted-foreground"}>{folder.starred ? "★" : "☆"}</span>
      </button>
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 truncate text-left">
        <span aria-hidden className="mr-1 text-muted-foreground">▸</span>{folder.name}
      </button>
      <span className="hidden items-center gap-1 group-hover:flex">
        <button type="button" onClick={() => { setName(folder.name); setRenaming(true); }} title="Rename" className="text-[10px] text-muted-foreground hover:text-foreground">✎</button>
        <button type="button" onClick={() => void remove()} title="Delete folder" className="text-[10px] text-muted-foreground hover:text-red-500">✕</button>
      </span>
    </li>
  );
}
