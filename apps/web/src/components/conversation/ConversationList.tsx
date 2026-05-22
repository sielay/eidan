"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Plus } from "lucide-react";

import { useAuth } from "@/components/providers/auth-provider";
import { Button } from "@/components/ui/button";
import {
  createConversation,
  listConversations,
  type ConversationSummary,
} from "@/lib/api/conversations";
import { cn } from "@/lib/utils";

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

      {error !== null ? (
        <p className="rounded-md border border-dashed border-border bg-background/60 p-3 text-xs text-red-600">
          {error}
        </p>
      ) : conversations === null ? (
        <p className="rounded-md border border-dashed border-border bg-background/60 p-3 text-xs text-muted-foreground">
          Loading…
        </p>
      ) : conversations.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-background/60 p-3 text-xs text-muted-foreground">
          No conversations yet. Start a new conversation above.
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {conversations.map((row) => (
            <li key={row.id}>
              <ConversationRow row={row} active={row.id === activeId} />
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
}: {
  row: ConversationSummary;
  active: boolean;
}): React.ReactElement {
  const label = row.title?.trim() ? row.title : "Untitled";
  return (
    <Link
      href={`/c/${row.id}`}
      aria-current={active ? "page" : undefined}
      className={cn(
        "block truncate rounded-md px-2 py-1.5 text-xs text-foreground transition-colors",
        active
          ? "bg-accent text-accent-foreground"
          : "hover:bg-accent/60 hover:text-accent-foreground text-muted-foreground",
      )}
    >
      {label}
    </Link>
  );
}
