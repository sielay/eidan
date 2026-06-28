// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { useAuth } from "@/components/providers/auth-provider";
import {
  fetchConversation,
  fetchConversationMessages,
  markConversationRead,
  type MessageRow,
} from "@/lib/api/conversations";
import { streamTurn } from "@/lib/api/turn";
import { loadProvider, saveProvider, listProviders, type ProviderOption } from "@/lib/models";
import { listOpenRouterModels, type OpenRouterModel } from "@/lib/api/admin";

import { buildThread, type StreamingAssistant } from "./buildThread";
import { Composer, type ComposerAttachment } from "./Composer";
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
 *    text + live tool calls accumulate from the AG-UI event stream
 *    (`docs/030`; protocol of record, #263).
 * 3. An ``inFlight`` flag that disables the composer while a turn is
 *    open, per `docs/014 §4.5`.
 *
 * On stream interruption (network drop, 5xx, ``RUN_FINISHED`` never
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
  // Agent-origin threads: which agent + why it ran (for the header banner).
  const [convInfo, setConvInfo] = React.useState<{ agent: string | null; agentId: string | null; trigger: string | null; detail: string | null } | null>(null);
  const [pendingUserText, setPendingUserText] = React.useState<string | null>(
    null,
  );
  const [streamingAssistant, setStreamingAssistant] =
    React.useState<StreamingAssistant | null>(null);
  const [inFlight, setInFlight] = React.useState(false);
  const [lastUserMessageId, setLastUserMessageId] = React.useState<
    string | null
  >(null);
  // Per-conversation model choice (a matbot provider name); persisted client-side.
  const [provider, setProvider] = React.useState("");
  React.useEffect(() => {
    setProvider(loadProvider(conversationId));
  }, [conversationId]);
  // The picker menu is built from the engine's live provider registry, so it can never offer a name
  // the engine doesn't have. We also reconcile the remembered pick against this list: a name saved
  // before a provider was renamed/removed is stale, and sending it would make the server reject the
  // turn — so drop it back to "" (host default). Without this, stale picks silently billed sonnet.
  const [providers, setProviders] = React.useState<ProviderOption[]>([]);
  React.useEffect(() => {
    listProviders()
      .then((list) => {
        setProviders(list);
        setProvider((cur) => {
          if (cur && !list.some((p) => p.name === cur)) {
            saveProvider(conversationId, "");
            return "";
          }
          return cur;
        });
      })
      .catch(() => setProviders([]));
  }, [conversationId]);
  const onProviderChange = React.useCallback(
    (p: string) => {
      setProvider(p);
      saveProvider(conversationId, p);
    },
    [conversationId],
  );
  // The full OpenRouter catalogue (all models), so chat + ⑂ Compare can pick ANY model — not just the
  // configured providers. The engine runs a chosen slug via an on-the-fly synthesized provider. Fetched
  // once (cached server-side 1h); degrades to configured-only if it fails.
  const [catalog, setCatalog] = React.useState<OpenRouterModel[]>([]);
  React.useEffect(() => {
    listOpenRouterModels().then(setCatalog).catch(() => setCatalog([]));
  }, []);
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
      setConvInfo(row.origin === "agent" ? { agent: row.agent_name ?? null, agentId: row.agent_id ?? null, trigger: row.trigger_desc ?? null, detail: row.run_detail ?? null } : null);
    } catch {
      // Title is a nicety — silent failure keeps the header readable.
    }
  }, [config, conversationId]);

  React.useEffect(() => {
    if (!config || !user) return;
    void reloadHistory();
    void reloadTitle();
    // Opening a conversation marks it read (clears its unread dot in the sidebar).
    void markConversationRead(conversationId);
  }, [config, user, conversationId, reloadHistory, reloadTitle]);

  const onSubmit = React.useCallback(
    async (text: string, attachments?: ComposerAttachment[], compare?: string[]) => {
      if (!config) throw new Error("auth config not ready");
      setPendingUserText(text);
      setStreamingAssistant({ text: "", interrupted: false, toolCalls: [] });
      setInFlight(true);

      // Reduce the AG-UI event stream (#263) into the optimistic
      // streaming-assistant row: text deltas append to the bubble, tool
      // calls accumulate and render live (#265/#267), and ``complete``
      // hands back the persisted ids that trigger the history re-fetch.
      const ensure = (prev: StreamingAssistant | null): StreamingAssistant =>
        prev ?? { text: "", interrupted: false, toolCalls: [] };

      let completed = false;
      try {
        for await (const event of streamTurn({
          conversationId,
          text,
          ...(provider ? { provider } : {}),
          ...(attachments && attachments.length ? { attachments } : {}),
          ...(compare && compare.length >= 2 ? { compare } : {}),
        })) {
          if (event.kind === "text") {
            setStreamingAssistant((prev) => {
              const base = ensure(prev);
              return { ...base, text: base.text + event.delta };
            });
          } else if (event.kind === "tool_call_start") {
            setStreamingAssistant((prev) => {
              const base = ensure(prev);
              return {
                ...base,
                toolCalls: [
                  ...base.toolCalls,
                  {
                    tool_call_id: event.tool_call_id,
                    tool_name: event.tool_name,
                    args_text: "",
                    result: null,
                  },
                ],
              };
            });
          } else if (event.kind === "tool_call_args") {
            setStreamingAssistant((prev) => {
              const base = ensure(prev);
              return {
                ...base,
                toolCalls: base.toolCalls.map((tc) =>
                  tc.tool_call_id === event.tool_call_id
                    ? { ...tc, args_text: tc.args_text + event.args_delta }
                    : tc,
                ),
              };
            });
          } else if (event.kind === "tool_call_result") {
            setStreamingAssistant((prev) => {
              const base = ensure(prev);
              return {
                ...base,
                toolCalls: base.toolCalls.map((tc) =>
                  tc.tool_call_id === event.tool_call_id
                    ? { ...tc, result: event.content }
                    : tc,
                ),
              };
            });
          } else if (event.kind === "complete") {
            completed = true;
            setLastUserMessageId(event.user_message_id);
            setTurnRefreshKey((key) => key + 1);
          }
          // ``error`` and ``unknown`` fall through: a RUN_ERROR ends the
          // stream and the cleanup branch below marks the partial row
          // ``[interrupted]`` per `docs/014 §4.6`.
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
        void markConversationRead(conversationId); // the turn just advanced updated_at; you saw it
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
    [config, conversationId, provider, reloadHistory, reloadTitle],
  );

  if (loading) {
    return (
      <div className="content">
        <p className="screen-sub">Loading…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="content">
        <p className="screen-sub">Sign in to view this conversation.</p>
      </div>
    );
  }

  const messages = buildThread({
    history,
    pendingUserText,
    streamingAssistant,
  });

  return (
    <div className="chat-screen">
      <header className="chat-head">
        <div className="chat-head__title">
          <ConversationTitle
            conversationId={conversationId}
            title={title}
            onChange={setTitle}
          />
          <CostCounter
            lastMessageId={lastUserMessageId}
            turnRefreshKey={turnRefreshKey}
          />
        </div>
        <button
          type="button"
          onClick={() => setTraceOpen((v) => !v)}
          aria-pressed={traceOpen}
          title="Show per-call LLM trace"
          className={traceOpen ? "chip chip--selected" : "chip"}
          style={{ height: 32, fontSize: "var(--fs-13)" }}
        >
          inspect
        </button>
      </header>

      {convInfo ? (
        <div
          title={convInfo.detail ?? undefined}
          style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", fontSize: "var(--fs-13)", background: "var(--accent-soft, rgba(99,102,241,0.10))", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}
        >
          <span aria-hidden>🤖</span>
          <span style={{ fontWeight: 600 }}>{convInfo.agent ?? "Agent"}</span>
          {convInfo.trigger ? <span style={{ color: "var(--muted)" }}>· {convInfo.trigger}</span> : null}
          {convInfo.detail ? <span style={{ color: "var(--faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>— {convInfo.detail}</span> : null}
        </div>
      ) : null}

      <div className="chat-thread">
        {history === null && historyError === null ? (
          <p className="screen-sub">Loading history…</p>
        ) : historyError !== null ? (
          <p className="screen-sub" style={{ color: "var(--alert)" }}>
            {historyError}
          </p>
        ) : (
          <Thread messages={messages} />
        )}
        {traceOpen ? (
          <div style={{ marginTop: "var(--s5)", borderTop: "1px solid var(--border)", paddingTop: "var(--s4)" }}>
            <LlmCallTrace
              conversationId={conversationId}
              refreshKey={turnRefreshKey}
            />
          </div>
        ) : null}
      </div>

      <Composer
        onSubmit={onSubmit}
        disabled={inFlight}
        provider={provider}
        onProviderChange={onProviderChange}
        providers={providers}
        catalog={catalog}
      />
    </div>
  );
}

