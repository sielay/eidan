// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { CheckSquare, ListChecks, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Square, Star, Tag, Trash2, X } from "lucide-react";

import { useAuth } from "@/components/providers/auth-provider";
import { Button } from "@/components/ui/button";
import {
  parseAgentName,
  THREAD_KIND_FILTERS,
  type ThreadKindFilter,
} from "@/lib/agent-thread";
import { formatAbsolute, formatRelative } from "@/lib/format-time";
import {
  createConversation,
  listConversations,
  regenerateConversationTitle,
  deleteConversation,
  updateConversationTitle,
  toggleConversationStar,
  tagConversations,
  moveConversationToFolder,
  isUnread,
  type ConversationSummary,
} from "@/lib/api/conversations";
import { listFolders, type Folder } from "@/lib/api/folders";
import { FoldersBar, type FolderFilter } from "./FoldersBar";
import { cn } from "@/lib/utils";

const FILTER_LABEL: Record<ThreadKindFilter, string> = {
  all: "All",
  agents: "Agents",
  chats: "Chats",
};

/**
 * Sidebar conversation list (`docs/014 §3`).
 *
 * Reads ``GET /api/conversations`` once on mount, renders the rows
 * ordered by ``created_at DESC`` (the backend already sorts on
 * ``idx_conversations_user_recent`` per `docs/003 §2`), and marks the
 * row matching the current ``/c/[conversation_id]`` route as active.
 *
 * The "New conversation" button POSTs to ``/api/conversations`` and
 * pushes the router to the new conversation's panel as soon as the
 * backend hands back its id, so the next render of
 * ``ConversationView`` is ready to receive the first message.
 *
 * Each row carries a kebab affordance that surfaces a small inline
 * menu with "Rename" and "Regenerate title" actions (issue #48).
 * Rename swaps the row into an inline input; regenerate fires
 * ``POST /api/conversations/{id}/regenerate_title`` and refreshes the
 * row in place.
 */
const PAGE = 50;

export function ConversationList(): React.ReactElement {
  const { config, user, loading } = useAuth();
  const router = useRouter();
  const params = useParams<{ conversation_id?: string }>();
  const activeId = params?.conversation_id ?? null;

  // The kind filter is permalinked via ?tab= (default "chats" so scheduled agent threads don't flood
  // the human list). Read/written via window+history rather than useSearchParams — the latter forces a
  // Suspense boundary and has bitten this app before (see telegram/link). Initialised from the URL on
  // mount (client-only), updated in place so the view stays shareable/bookmarkable.
  const [filter, setFilterState] = React.useState<ThreadKindFilter>("chats");
  React.useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t === "agents" || t === "all") setFilterState(t);
  }, []);
  const setFilter = React.useCallback((kind: ThreadKindFilter) => {
    setFilterState(kind);
    const sp = new URLSearchParams(window.location.search);
    if (kind === "chats") sp.delete("tab"); else sp.set("tab", kind);
    const qs = sp.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, []);

  const [items, setItems] = React.useState<ConversationSummary[] | null>(null);
  const [nextBefore, setNextBefore] = React.useState<string | null>(null);
  const [nextBeforeStarred, setNextBeforeStarred] = React.useState<boolean | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [tagFilter, setTagFilter] = React.useState<string | null>(null);

  // Folders: the list of the user's folders + the currently-selected filter (folder id | "none" | null).
  const [folders, setFolders] = React.useState<Folder[]>([]);
  const [folderFilter, setFolderFilter] = React.useState<FolderFilter>(null);
  const reloadFolders = React.useCallback(() => {
    if (!config || !user) return;
    void listFolders().then(setFolders).catch(() => undefined);
  }, [config, user]);
  React.useEffect(() => { reloadFolders(); }, [reloadFolders]);
  const folderArg = folderFilter === null ? {} : { folder: folderFilter };

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  // (Re)load the first page whenever auth, filter, or the (debounced) search change.
  React.useEffect(() => {
    if (!config || !user) return;
    let cancelled = false;
    setItems(null);
    setError(null);
    setNextBefore(null);
    setNextBeforeStarred(null);
    (async () => {
      try {
        const { conversations, nextBefore, nextBeforeStarred } = await listConversations({ limit: PAGE, kind: filter, q: debounced, ...(tagFilter ? { tag: tagFilter } : {}), ...folderArg });
        if (cancelled) return;
        setItems(conversations);
        setNextBefore(nextBefore);
        setNextBeforeStarred(nextBeforeStarred);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "failed to load conversations");
      }
    })();
    return () => { cancelled = true; };
  }, [config, user, filter, debounced, tagFilter, folderFilter]);

  const onRowStarChange = React.useCallback(
    (rowId: string, nextStarred: boolean, updatedAt: string) => {
      setItems((prev) => {
        // No items loaded yet; defer until items are available
        if (prev === null) return prev;
        const itemIdx = prev.findIndex((r) => r.id === rowId);
        if (itemIdx === -1) return prev;
        const updated = prev[itemIdx];
        const newItem = { ...updated, starred: nextStarred, updated_at: updatedAt };
        // Remove the item and re-sort to match server sort order (starred DESC, updated_at DESC)
        const remaining = [...prev.slice(0, itemIdx), ...prev.slice(itemIdx + 1)];
        if (nextStarred) {
          // Find insertion point: after other starred items with same or later updated_at
          const insertIdx = remaining.findIndex((r) => !r.starred || r.updated_at < updatedAt);
          return insertIdx === -1
            ? [...remaining, newItem]
            : [...remaining.slice(0, insertIdx), newItem, ...remaining.slice(insertIdx)];
        }
        // When unstarring, insert back into unstarred items maintaining updated_at DESC order
        const insertIdx = remaining.findIndex((r) => r.updated_at < updatedAt);
        return insertIdx === -1
          ? [...remaining, newItem]
          : [...remaining.slice(0, insertIdx), newItem, ...remaining.slice(insertIdx)];
      });
    },
    [],
  );

  // A row moved to a folder: update its folder_id, and drop it from view if a folder filter is active
  // and it no longer matches (it went elsewhere).
  const onRowMoved = React.useCallback(
    (rowId: string, folderId: string | null) => {
      setItems((prev) => {
        if (prev === null) return prev;
        const matchesFilter =
          folderFilter === null ||
          (folderFilter === "none" ? folderId === null : folderId === folderFilter);
        if (!matchesFilter) return prev.filter((r) => r.id !== rowId);
        return prev.map((r) => (r.id === rowId ? { ...r, folder_id: folderId } : r));
      });
    },
    [folderFilter],
  );

  const loadMore = React.useCallback(async () => {
    if (loadingMore || !nextBefore || !config) return;
    setLoadingMore(true);
    try {
      const page = await listConversations({ limit: PAGE, kind: filter, q: debounced, before: nextBefore, beforeStarred: nextBeforeStarred, ...(tagFilter ? { tag: tagFilter } : {}), ...folderArg });
      setItems((prev) => [...(prev ?? []), ...page.conversations]);
      setNextBefore(page.nextBefore);
      setNextBeforeStarred(page.nextBeforeStarred);
    } catch { /* keep what we have; the next scroll-into-view retries */ } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, nextBefore, nextBeforeStarred, config, filter, debounced, tagFilter, folderFilter]);

  // Infinite scroll. The observer is created ONCE and calls the latest loadMore via a ref — putting
  // loadMore in the effect deps would re-create the observer on every loadingMore/nextBefore change,
  // and a freshly-observed sentinel that's still in view re-fires immediately, eagerly loading EVERY
  // page back-to-back on mount (thousands of rows → the tab crashes). IntersectionObserver only fires
  // on intersection *change*, so a stable observer loads exactly one page per scroll-into-view.
  const loadMoreRef = React.useRef(loadMore);
  React.useEffect(() => { loadMoreRef.current = loadMore; }, [loadMore]);
  const sentinelRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) void loadMoreRef.current(); },
      { rootMargin: "240px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const onNewConversation = React.useCallback(async () => {
    if (!config || creating) return;
    setCreating(true);
    try {
      const created = await createConversation();
      router.push(`/c/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create conversation");
      setCreating(false);
    }
  }, [config, creating, router]);

  const onRowTitleChange = React.useCallback(
    (rowId: string, nextTitle: string | null) => {
      setItems((prev) => prev === null ? prev : prev.map((row) => row.id === rowId ? { ...row, title: nextTitle } : row));
    },
    [],
  );

  const onRowDeleted = React.useCallback(
    (rowId: string) => {
      setItems((prev) => (prev === null ? prev : prev.filter((row) => row.id !== rowId)));
      if (rowId === activeId) router.push("/c"); // the open conversation was deleted → leave it
    },
    [activeId, router],
  );

  // ── Multi-select + bulk actions (cleanup; first action is delete, later: tag/label/etc.) ──────────
  const [selectMode, setSelectMode] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const exitSelect = React.useCallback(() => { setSelectMode(false); setSelected(new Set()); }, []);
  // Leaving select mode whenever the list reloads (filter/search) avoids stale ids surviving across views.
  React.useEffect(() => { exitSelect(); }, [filter, debounced, exitSelect]);
  const toggleSelect = React.useCallback((id: string) => {
    setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }, []);
  const selectAllLoaded = React.useCallback(() => {
    setSelected(new Set((items ?? []).map((r) => r.id)));
  }, [items]);
  // Labels present across the loaded rows — drives the filter chips. (Tag filtering itself is server-side.)
  const allTags = React.useMemo(() => Array.from(new Set((items ?? []).flatMap((r) => r.tags ?? []))).sort(), [items]);
  const bulkTag = React.useCallback(async () => {
    if (selected.size === 0 || bulkBusy) return;
    const raw = typeof window !== "undefined" ? window.prompt(`Add a label to ${selected.size} conversation${selected.size === 1 ? "" : "s"}`) : null;
    const tag = raw?.trim();
    if (!tag) return;
    setBulkBusy(true);
    const ids = Array.from(selected);
    try {
      await tagConversations(ids, { add: [tag] });
      setItems((prev) => (prev === null ? prev : prev.map((r) => (selected.has(r.id) ? { ...r, tags: Array.from(new Set([...(r.tags ?? []), tag])) } : r))));
      exitSelect();
    } catch { setError("Couldn't apply the label — try again."); } finally { setBulkBusy(false); }
  }, [selected, bulkBusy, exitSelect]);
  const bulkDelete = React.useCallback(async () => {
    if (selected.size === 0 || bulkBusy) return;
    if (typeof window !== "undefined" && !window.confirm(`Delete ${selected.size} conversation${selected.size === 1 ? "" : "s"}? Their messages are kept for audit but they're removed from your list.`)) return;
    setBulkBusy(true);
    const ids = Array.from(selected);
    const results = await Promise.allSettled(ids.map((id) => deleteConversation(id)));
    const ok = new Set(ids.filter((_, i) => results[i]?.status === "fulfilled"));
    if (ok.size) {
      setItems((prev) => (prev === null ? prev : prev.filter((row) => !ok.has(row.id))));
      if (activeId && ok.has(activeId)) router.push("/c");
    }
    setBulkBusy(false);
    const failed = ids.length - ok.size;
    if (failed > 0) { setSelected(new Set(ids.filter((id) => !ok.has(id)))); setError(`${failed} couldn't be deleted — try again.`); }
    else exitSelect();
  }, [selected, bulkBusy, activeId, router, exitSelect]);

  if (loading || !user) {
    return (
      <div
        data-slot="conversation-list"
        className="rounded-md border border-dashed border-border bg-background/60 p-3 text-xs text-muted-foreground"
      >
        Sign in to see your conversations.
      </div>
    );
  }

  return (
    <div data-slot="conversation-list" className="flex flex-col gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={onNewConversation}
        disabled={creating}
        className="justify-start"
      >
        <Plus className="h-3.5 w-3.5" />
        {creating ? "Creating…" : "New conversation"}
      </Button>

      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search conversations…"
          aria-label="Search conversations"
          className="w-full rounded-md border border-border bg-background py-1.5 pl-7 pr-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      <div
        role="tablist"
        aria-label="Filter conversations by kind"
        className="inline-flex w-full rounded-md border border-border bg-background/60 p-0.5 text-[10px]"
      >
        {THREAD_KIND_FILTERS.map((kind) => (
          <button
            key={kind}
            type="button"
            role="tab"
            aria-selected={filter === kind}
            onClick={() => setFilter(kind)}
            className={cn(
              "flex-1 rounded px-2 py-1 font-medium uppercase tracking-wider transition-colors",
              filter === kind
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {FILTER_LABEL[kind]}
          </button>
        ))}
      </div>

      {(allTags.length > 0 || tagFilter) ? (
        <div className="flex flex-wrap items-center gap-1">
          {tagFilter ? (
            <button type="button" onClick={() => setTagFilter(null)} className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium text-accent-foreground" title="Clear label filter">
              <Tag className="h-2.5 w-2.5" /> {tagFilter} <X className="h-2.5 w-2.5" />
            </button>
          ) : (
            allTags.map((t) => (
              <button key={t} type="button" onClick={() => setTagFilter(t)} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-accent-foreground" title={`Filter by ${t}`}>
                <Tag className="h-2.5 w-2.5" /> {t}
              </button>
            ))
          )}
        </div>
      ) : null}

      <FoldersBar folders={folders} selected={folderFilter} onSelect={setFolderFilter} onChanged={reloadFolders} />

      {error !== null ? (
        <p className="rounded-md border border-dashed border-border bg-background/60 p-3 text-xs text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      ) : items === null ? (
        <p className="rounded-md border border-dashed border-border bg-background/60 p-3 text-xs text-muted-foreground">
          Loading…
        </p>
      ) : items.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-background/60 p-3 text-xs text-muted-foreground">
          {debounced ? `No conversations match “${debounced}”.` : "No conversations yet. Start a new conversation above."}
        </p>
      ) : (
        <>
          {selectMode ? (
            <div className="flex items-center gap-1.5 rounded-md border border-border bg-accent/40 px-2 py-1 text-xs">
              <span className="font-medium tabular-nums">{selected.size} selected</span>
              <button type="button" onClick={selectAllLoaded} className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground">All</button>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => void bulkTag()}
                disabled={selected.size === 0 || bulkBusy}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40"
              >
                <Tag className="h-3 w-3" /> Tag
              </button>
              <button
                type="button"
                onClick={() => void bulkDelete()}
                disabled={selected.size === 0 || bulkBusy}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-red-600 hover:bg-red-50 disabled:opacity-40 dark:text-red-400 dark:hover:bg-red-950/40"
              >
                <Trash2 className="h-3 w-3" />
                {bulkBusy ? "Deleting…" : "Delete"}
              </button>
              <button type="button" onClick={exitSelect} aria-label="Cancel selection" className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground">
                <X className="h-3 w-3" /> Cancel
              </button>
            </div>
          ) : (
            <div className="flex justify-end">
              <button type="button" onClick={() => setSelectMode(true)} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-accent hover:text-accent-foreground" title="Select multiple to delete in bulk">
                <ListChecks className="h-3 w-3" /> Select
              </button>
            </div>
          )}
          <ul className="flex flex-col gap-0.5">
            {items.map((row) => (
              <li key={row.id}>
                <ConversationRow
                  row={row}
                  active={row.id === activeId}
                  selectMode={selectMode}
                  isSelected={selected.has(row.id)}
                  onToggleSelect={() => toggleSelect(row.id)}
                  onTitleChange={(next) => onRowTitleChange(row.id, next)}
                  onStarChange={(next, updatedAt) => onRowStarChange(row.id, next, updatedAt)}
                  onDeleted={() => onRowDeleted(row.id)}
                  folders={folders}
                  onMoved={(folderId) => onRowMoved(row.id, folderId)}
                />
              </li>
            ))}
          </ul>
        </>
      )}

      <div ref={sentinelRef} />
      {loadingMore ? <p className="py-1 text-center text-[10px] text-muted-foreground">Loading more…</p> : null}
    </div>
  );
}

function ConversationRow({
  row,
  active,
  selectMode,
  isSelected,
  onToggleSelect,
  onTitleChange,
  onStarChange,
  onDeleted,
  folders,
  onMoved,
}: {
  row: ConversationSummary;
  active: boolean;
  selectMode: boolean;
  isSelected: boolean;
  onToggleSelect: () => void;
  onTitleChange: (next: string | null) => void;
  onStarChange: (next: boolean, updatedAt: string) => void;
  onDeleted: () => void;
  folders: Folder[];
  onMoved: (folderId: string | null) => void;
}): React.ReactElement {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState<"save" | "regen" | "star" | "delete" | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);

  // Close the kebab menu on outside click — the rows render without
  // a portaled overlay so a plain document-level listener is enough.
  React.useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  React.useEffect(() => {
    if (editing) {
      setDraft(row.title ?? "");
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, row.title]);

  const beginRename = React.useCallback(() => {
    setMenuOpen(false);
    setEditing(true);
  }, []);

  const commitRename = React.useCallback(async () => {
    const next = draft.trim();
    if ((next || null) === (row.title ?? null)) {
      setEditing(false);
      return;
    }
    setBusy("save");
    try {
      const body = await updateConversationTitle(
        row.id,
        next ? next : null,
      );
      onTitleChange(body.title);
      setEditing(false);
    } catch {
      // Swallow: leaving editing=true so the operator can retry.
    } finally {
      setBusy(null);
    }
  }, [draft, onTitleChange, row.id, row.title]);

  const onRegenerate = React.useCallback(async () => {
    setMenuOpen(false);
    if (busy !== null) return;
    setBusy("regen");
    try {
      const body = await regenerateConversationTitle(row.id);
      onTitleChange(body.title);
    } catch {
      // Swallow: operator can retry from the menu.
    } finally {
      setBusy(null);
    }
  }, [busy, onTitleChange, row.id]);

  const onToggleStar = React.useCallback(async () => {
    if (busy !== null) return;
    setBusy("star");
    try {
      const nextStarred = !(row.starred ?? false);
      const body = await toggleConversationStar(row.id, nextStarred);
      onStarChange(body.starred, body.updated_at);
    } catch (err) {
      console.error("Failed to toggle star:", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [busy, onStarChange, row.id, row.starred]);

  const onDelete = React.useCallback(async () => {
    setMenuOpen(false);
    if (busy !== null) return;
    if (typeof window !== "undefined" && !window.confirm("Delete this conversation? Its messages are kept for audit but it's removed from your list.")) return;
    setBusy("delete");
    try {
      await deleteConversation(row.id);
      onDeleted(); // parent removes the row (and navigates away if it was active)
    } catch (err) {
      console.error("Failed to delete conversation:", err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }, [busy, onDeleted, row.id]);

  const onMove = React.useCallback(async (folderId: string | null) => {
    setMenuOpen(false);
    try { await moveConversationToFolder(row.id, folderId); onMoved(folderId); }
    catch (err) { console.error("Failed to move conversation:", err instanceof Error ? err.message : String(err)); }
  }, [row.id, onMoved]);

  if (editing) {
    return (
      <div className="flex items-center gap-1 rounded-md bg-accent/40 px-2 py-1">
        <input
          ref={inputRef}
          value={draft}
          maxLength={200}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commitRename();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
          disabled={busy === "save"}
          aria-label="Rename conversation"
          className="w-full rounded-sm bg-background px-1.5 py-0.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
    );
  }

  const label = row.title?.trim() ? row.title : "Untitled";
  const agentName = parseAgentName(row.title);

  // Selection mode: the whole row toggles a checkbox (no nav, no star/kebab) so you can sweep-delete.
  if (selectMode) {
    return (
      <button
        type="button"
        role="checkbox"
        aria-checked={isSelected}
        onClick={onToggleSelect}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
          isSelected ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/60",
        )}
      >
        {isSelected ? <CheckSquare className="h-3.5 w-3.5 shrink-0 text-accent-foreground" /> : <Square className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        {agentName !== null ? (
          <span className="shrink-0 rounded-full bg-blue-500/10 px-1.5 py-0 font-mono text-[10px] uppercase tracking-wider text-blue-700 dark:text-blue-300">{agentName}</span>
        ) : null}
        <span className={cn("min-w-0 flex-1 truncate", row.title === null && "italic")}>{label}</span>
        <time dateTime={row.updated_at} className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{formatRelative(row.updated_at)}</time>
      </button>
    );
  }

  return (
    <div className="group relative flex items-center gap-1">
      <Link
        href={`/c/${row.id}`}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex flex-1 min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-foreground transition-colors",
          active
            ? "bg-accent text-accent-foreground"
            : "hover:bg-accent/60 hover:text-accent-foreground text-muted-foreground",
          row.title === null && "italic",
        )}
      >
        {!active && isUnread(row) ? (
          <span className="h-2 w-2 shrink-0 rounded-full bg-blue-500" title="Unread — new messages since you last opened it" aria-label="Unread" />
        ) : null}
        {agentName !== null ? (
          <span
            title={`Agent-spawned thread (${agentName})`}
            className="shrink-0 rounded-full bg-blue-500/10 px-1.5 py-0 font-mono text-[10px] uppercase tracking-wider text-blue-700 dark:text-blue-300"
          >
            {agentName}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate">
          {busy === "regen" ? (
            <span className="inline-flex items-center gap-1">
              <RefreshCw className="h-3 w-3 animate-spin" />
              {label}
            </span>
          ) : (
            label
          )}
        </span>
        {row.tags && row.tags.length ? (
          <span className="flex shrink-0 items-center gap-0.5">
            {row.tags.slice(0, 2).map((t) => (
              <span key={t} className="max-w-16 truncate rounded bg-accent/70 px-1 text-[8px] font-medium uppercase tracking-wide text-accent-foreground">{t}</span>
            ))}
          </span>
        ) : null}
        <time
          dateTime={row.updated_at}
          title={formatAbsolute(row.updated_at)}
          className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground"
        >
          {formatRelative(row.updated_at)}
        </time>
      </Link>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          void onToggleStar();
        }}
        disabled={busy === "star"}
        aria-label={row.starred ? "Unstar conversation" : "Star conversation"}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded-md transition-opacity",
          row.starred ? "text-amber-500 opacity-100" : "text-muted-foreground",
          !row.starred && "hover:text-foreground hover:bg-accent/60",
          row.starred && "hover:text-amber-600 hover:bg-accent/60",
          !row.starred && (menuOpen || active ? "opacity-100" : "opacity-0 group-hover:opacity-100"),
        )}
      >
        <Star className={cn("h-3.5 w-3.5", row.starred && "fill-current")} />
      </button>
      <div ref={menuRef} className="relative">
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            setMenuOpen((open) => !open);
          }}
          aria-label="Conversation actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-opacity",
            "hover:bg-accent/60 hover:text-accent-foreground",
            menuOpen || active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
        {menuOpen ? (
          <div
            role="menu"
            className="absolute right-0 top-7 z-10 min-w-40 rounded-md border border-border bg-background shadow-md"
          >
            <button
              type="button"
              role="menuitem"
              onClick={beginRename}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground"
            >
              <Pencil className="h-3 w-3" />
              Rename
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => void onRegenerate()}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground"
            >
              <RefreshCw className="h-3 w-3" />
              Regenerate title
            </button>
            {folders.length > 0 || row.folder_id ? (
              <div className="border-t border-border py-1">
                <p className="px-3 pb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">Move to</p>
                <div className="max-h-40 overflow-y-auto">
                  {row.folder_id ? (
                    <button type="button" role="menuitem" onClick={() => void onMove(null)} className="flex w-full items-center gap-2 px-3 py-1 text-xs hover:bg-accent hover:text-accent-foreground">
                      <span className="text-muted-foreground">↩</span> Unfiled
                    </button>
                  ) : null}
                  {folders.filter((f) => f.id !== row.folder_id).map((f) => (
                    <button key={f.id} type="button" role="menuitem" onClick={() => void onMove(f.id)} className="flex w-full items-center gap-2 px-3 py-1 text-xs hover:bg-accent hover:text-accent-foreground">
                      <span className="text-muted-foreground">▸</span> <span className="truncate">{f.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <button
              type="button"
              role="menuitem"
              onClick={() => void onDelete()}
              style={{ borderTop: "1px solid var(--border)" }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              <Trash2 className="h-3 w-3" />
              Delete
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
