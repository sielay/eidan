"use client";

import * as React from "react";

import { useAuth } from "@/components/providers/auth-provider";
import {
  fetchConversation,
  fetchConversationMessages,
  type MessageRow,
} from "@/lib/api/conversations";
import { streamTurn } from "@/lib/api/turn";

import { buildThread } from "./buildThread";
import { Composer } from "./Composer";
import { ConversationTitle } from "./ConversationTitle";
import { CostCounter } from "./CostCounter";
import { LlmCallTrace } from "./LlmCallTrace";
import { Thread } from "./Thread";

/**
 * Top-level chat panel for ``/c/[conversation_id]``.
 *
 * Owns three pieces of state:
 *
 * 1. The persisted history fetched from
 *    ``GET /api/conversations/{id}/messages`` on mount and re-fetched
 *    after every successful turn so the UI's keys flip from the
 *    synthetic ``pending-…`` ids to the backend-assigned ones
 *    (`docs/014 §4` — every visible datum derives from the backend
 *    payload).
 * 2. Two optimistic placeholder rows during a streaming turn: the
 *    user message we just submitted, and the assistant message whose
 *    text accumulates from each ``chunk`` SSE frame
 *    (`docs/005 §5.5`).
 * 3. An ``inFlight`` flag that disables the composer while a turn is
 *    open, per `docs/014 §4.5`.
 *
 * On stream interruption (network drop, 5xx, ``complete`` never
 * arrived) the partial assistant text is preserved with an
 * ``[interrupted]`` marker per `docs/014 §4.6`.
 */
export function ConversationView({
  conversationId,
}: {
  conversationId: string;
}): React.ReactElement {
  const { config, user, loading } = useAuth();

  const [history, setHistory] = React.useState<MessageRow[] | null>(null);
  const [historyError, setHistoryError] = React.useState<string | null>(null);
  const [title, setTitle] = React.useState<string | null>(null);
  const [pendingUserText, setPendingUserText] = React.useState<string | null>(
    null,
  );
  const [streamingAssistant, setStreamingAssistant] = React.useState<{
    text: string;
    interrupted: boolean;
  } | null>(null);
  const [inFlight, setInFlight] = React.useState(false);
  const [lastUserMessageId, setLastUserMessageId] = React.useState<
    string | null
  >(null);
  const [turnRefreshKey, setTurnRefreshKey] = React.useState(0);
  const [traceOpen, setTraceOpen] = React.useState(false);

  const reloadHistory = React.useCallback(async () => {
    if (!config) return;
    try {
      const rows = await fetchConversationMessages(conversationId);
      setHistory(rows);
      setHistoryError(null);
    } catch (err) {
      setHistoryError(
        err instanceof Error ? err.message : "failed to load conversation",
      );
    }
  }, [config, conversationId]);

  const reloadTitle = React.useCallback(async () => {
    if (!config) return;
    try {
      const row = await fetchConversation(conversationId);
      setTitle(row.title);
    } catch {
      // Title is a nicety — silent failure keeps the header readable.
    }
  }, [config, conversationId]);

  React.useEffect(() => {
    if (!config || !user) return;
    void reloadHistory();
    void reloadTitle();
  }, [config, user, reloadHistory, reloadTitle]);

  const onSubmit = React.useCallback(
    async (text: string) => {
      if (!config) throw new Error("auth config not ready");
      setPendingUserText(text);
      setStreamingAssistant({ text: "", interrupted: false });
      setInFlight(true);

      let completed = false;
      try {
        for await (const event of streamTurn({
          conversationId,
          text,
        })) {
          if (event.kind === "chunk") {
            setStreamingAssistant((prev) =>
              prev
                ? { text: prev.text + event.text, interrupted: false }
                : { text: event.text, interrupted: false },
            );
          } else if (event.kind === "complete") {
            completed = true;
            setLastUserMessageId(event.user_message_id);
            setTurnRefreshKey((key) => key + 1);
          }
        }
      } catch {
        // Stream interrupted — fall through to the cleanup branch
        // below so the partial assistant content stays visible.
      }

      if (completed) {
        setPendingUserText(null);
        setStreamingAssistant(null);
        setInFlight(false);
        await reloadHistory();
        // Auto-title runs as a fire-and-forget task on the backend
        // (issue #48). Re-fetch a couple of times so the header
        // updates without the operator having to refresh.
        void reloadTitle();
        window.setTimeout(() => {
          void reloadTitle();
        }, 1500);
      } else {
        // 500 or stream interruption: keep the partial assistant text
        // visible with the [interrupted] marker per `docs/014 §4.6`.
        setStreamingAssistant((prev) =>
          prev ? { ...prev, interrupted: true } : prev,
        );
        setInFlight(false);
      }
    },
    [config, conversationId, reloadHistory, reloadTitle],
  );

  if (loading) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-10">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-10">
        <p className="text-sm text-muted-foreground">
          Sign in to view this conversation.
        </p>
      </div>
    );
  }

  const messages = buildThread({
    history,
    pendingUserText,
    streamingAssistant,
  });

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col px-6 py-6">
      <header className="mb-4 flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0 flex-1">
            <ConversationTitle
              conversationId={conversationId}
              title={title}
              onChange={setTitle}
            />
          </div>
          <button
            type="button"
            onClick={() => setTraceOpen((v) => !v)}
            aria-pressed={traceOpen}
            title="Show per-call LLM trace"
            className={
              traceOpen
                ? "rounded-md border border-primary bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary"
                : "rounded-md border border-border bg-background/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
            }
          >
            inspect
          </button>
          <span className="font-mono text-xs text-muted-foreground">
            {conversationId.slice(0, 8)}…
          </span>
        </div>
      </header>

      <div className="mb-3 border-b border-border pb-2">
        <CostCounter
          lastMessageId={lastUserMessageId}
          turnRefreshKey={turnRefreshKey}
        />
      </div>

      <div className="flex-1 overflow-y-auto pb-4">
        {history === null && historyError === null ? (
          <p className="text-sm text-muted-foreground">Loading history…</p>
        ) : historyError !== null ? (
          <p className="text-sm text-red-600">{historyError}</p>
        ) : (
          <Thread messages={messages} />
        )}
        {traceOpen ? (
          <div className="mt-6 border-t border-border pt-4">
            <LlmCallTrace
              conversationId={conversationId}
              refreshKey={turnRefreshKey}
            />
          </div>
        ) : null}
      </div>

      <div className="border-t border-border pt-3">
        <Composer onSubmit={onSubmit} disabled={inFlight} />
      </div>
    </div>
  );
}

