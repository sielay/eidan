// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { MoreHorizontal, Pencil, Plus, RefreshCw } from "lucide-react";

import { useAuth } from "@/components/providers/auth-provider";
import { Button } from "@/components/ui/button";
import {
  filterMatches,
  parseAgentName,
  THREAD_KIND_FILTERS,
  type ThreadKindFilter,
} from "@/lib/agent-thread";
import {
  createConversation,
  listConversations,
  regenerateConversationTitle,
  updateConversationTitle,
  type ConversationSummary,
} from "@/lib/api/conversations";
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
export function ConversationList(): React.ReactElement {
  const { config, user, loading } = useAuth();
  const router = useRouter();
  const params = useParams<{ conversation_id?: string }>();
  const activeId = params?.conversation_id ?? null;

  const [conversations, setConversations] = React.useState<
    ConversationSummary[] | null
  >(null);
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  // Default to "chats" so agent threads (e.g. a 5-min scheduled agent) don't flood the human list;
  // the "agents" / "all" tabs surface them on demand.
  const [filter, setFilter] = React.useState<ThreadKindFilter>("chats");

  const visible = React.useMemo(() => {
    if (conversations === null) return null;
    return conversations.filter((row) =>
      filterMatches(filter, parseAgentName(row.title)),
    );
  }, [conversations, filter]);

  React.useEffect(() => {
    if (!config || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await listConversations();
        if (cancelled) return;
        setConversations(rows);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "failed to load conversations",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config, user]);

  const onNewConversation = React.useCallback(async () => {
    if (!config || creating) return;
    setCreating(true);
    try {
      const created = await createConversation();
      router.push(`/c/${created.id}`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "failed to create conversation",
      );
      setCreating(false);
    }
  }, [config, creating, router]);

  const onRowTitleChange = React.useCallback(
    (rowId: string, nextTitle: string | null) => {
      setConversations((prev) =>
        prev === null
          ? prev
          : prev.map((row) =>
              row.id === rowId ? { ...row, title: nextTitle } : row,
            ),
      );
    },
    [],
  );

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

      {error !== null ? (
        <p className="rounded-md border border-dashed border-border bg-background/60 p-3 text-xs text-red-600">
          {error}
        </p>
      ) : conversations === null || visible === null ? (
        <p className="rounded-md border border-dashed border-border bg-background/60 p-3 text-xs text-muted-foreground">
          Loading…
        </p>
      ) : conversations.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-background/60 p-3 text-xs text-muted-foreground">
          No conversations yet. Start a new conversation above.
        </p>
      ) : visible.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-background/60 p-3 text-xs text-muted-foreground">
          No {filter === "agents" ? "agent threads" : "chats"} in this view.
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {visible.map((row) => (
            <li key={row.id}>
              <ConversationRow
                row={row}
                active={row.id === activeId}
                onTitleChange={(next) => onRowTitleChange(row.id, next)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConversationRow({
  row,
  active,
  onTitleChange,
}: {
  row: ConversationSummary;
  active: boolean;
  onTitleChange: (next: string | null) => void;
}): React.ReactElement {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState<"save" | "regen" | null>(null);
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

  return (
    <div className="group relative flex items-center gap-1">
      <Link
        href={`/c/${row.id}`}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex flex-1 min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-foreground transition-colors",
          active
            ? "bg-accent text-accent-foreground"
            : "hover:bg-accent/60 hover:text-accent-foreground text-muted-foreground",
          row.title === null && "italic",
        )}
      >
        {agentName !== null ? (
          <span
            title={`Agent-spawned thread (${agentName})`}
            className="shrink-0 rounded-full bg-blue-500/10 px-1.5 py-0 font-mono text-[9px] uppercase tracking-wider text-blue-700 dark:text-blue-300"
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
      </Link>
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
          </div>
        ) : null}
      </div>
    </div>
  );
}
