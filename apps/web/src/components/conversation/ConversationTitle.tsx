// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { Pencil, RefreshCw, Check, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  regenerateConversationTitle,
  updateConversationTitle,
} from "@/lib/api/conversations";

/**
 * Conversation-header title row (issue #48).
 *
 * Renders the persisted title (or "Untitled" when null), with three
 * affordances:
 *
 * 1. Click the title (or the pencil icon) to enter inline edit mode.
 *    Enter saves, Escape cancels.
 * 2. The refresh icon force-regenerates the title from the first
 *    user/assistant exchange via
 *    ``POST /api/conversations/{id}/regenerate_title``.
 * 3. While saving or regenerating, the affordances are disabled and
 *    the icons spin / dim so the operator can't double-fire.
 *
 * Backend is authoritative — the component reflects the title from
 * its ``title`` prop and only ever calls the parent's ``onChange``
 * once a successful API response lands.
 */
export function ConversationTitle({
  conversationId,
  title,
  onChange,
}: {
  conversationId: string;
  title: string | null;
  onChange: (next: string | null) => void;
}): React.ReactElement {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState<"save" | "regen" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (editing) {
      setDraft(title ?? "");
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, title]);

  const beginEdit = React.useCallback(() => {
    if (busy !== null) return;
    setError(null);
    setEditing(true);
  }, [busy]);

  const cancelEdit = React.useCallback(() => {
    setEditing(false);
    setError(null);
  }, []);

  const commit = React.useCallback(async () => {
    const next = draft.trim();
    // No-op when the trimmed draft matches the existing title (or
    // when both are empty / null).
    if ((next || null) === (title ?? null)) {
      setEditing(false);
      return;
    }
    setBusy("save");
    try {
      const body = await updateConversationTitle(
        conversationId,
        next ? next : null,
      );
      onChange(body.title);
      setEditing(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to save title");
    } finally {
      setBusy(null);
    }
  }, [conversationId, draft, onChange, title]);

  const regenerate = React.useCallback(async () => {
    if (busy !== null) return;
    setBusy("regen");
    setError(null);
    try {
      const body = await regenerateConversationTitle(conversationId);
      onChange(body.title);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "failed to regenerate title",
      );
    } finally {
      setBusy(null);
    }
  }, [busy, conversationId, onChange]);

  const display = title?.trim() ? title : "Untitled";

  return (
    <div data-slot="conversation-title" className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {editing ? (
          <>
            <input
              ref={inputRef}
              value={draft}
              maxLength={200}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void commit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelEdit();
                }
              }}
              disabled={busy === "save"}
              aria-label="Conversation title"
              className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-base font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button
              variant="ghost"
              size="icon"
              // shadcn's default icon size is 40px; the header inline
              // controls read better at 28px so they don't dominate.
              style={{ height: 28, width: 28 }}
              onClick={() => void commit()}
              disabled={busy === "save"}
              aria-label="Save title"
              title="Save"
            >
              <Check className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              // shadcn's default icon size is 40px; the header inline
              // controls read better at 28px so they don't dominate.
              style={{ height: 28, width: 28 }}
              onClick={cancelEdit}
              disabled={busy === "save"}
              aria-label="Cancel rename"
              title="Cancel"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </>
        ) : (
          <>
            <h1
              role="button"
              tabIndex={0}
              onClick={beginEdit}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  beginEdit();
                }
              }}
              className={cn(
                "flex-1 truncate rounded-md px-1 py-0.5 text-base font-semibold tracking-tight cursor-text outline-none",
                "hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring",
                title === null && "text-muted-foreground italic",
              )}
              title="Click to rename"
            >
              {display}
            </h1>
            <Button
              variant="ghost"
              size="icon"
              // shadcn's default icon size is 40px; the header inline
              // controls read better at 28px so they don't dominate.
              style={{ height: 28, width: 28 }}
              onClick={beginEdit}
              disabled={busy !== null}
              aria-label="Rename conversation"
              title="Rename"
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              // shadcn's default icon size is 40px; the header inline
              // controls read better at 28px so they don't dominate.
              style={{ height: 28, width: 28 }}
              onClick={() => void regenerate()}
              disabled={busy !== null}
              aria-label="Regenerate title"
              title="Regenerate title"
            >
              <RefreshCw
                className={cn(
                  "h-3.5 w-3.5",
                  busy === "regen" && "animate-spin",
                )}
              />
            </Button>
          </>
        )}
      </div>
      {error !== null ? (
        <p className="text-xs text-red-600">{error}</p>
      ) : null}
    </div>
  );
}
