// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/components/providers/auth-provider";
import {
  fetchConversation,
  fetchConversationMessages,
  markConversationRead,
  createConversation,
  moveConversationToFolder,
  type MessageRow,
} from "@/lib/api/conversations";
import { streamTurn, answerPrompt, type AskField } from "@/lib/api/turn";
import { loadProvider, saveProvider, listProviders, type ProviderOption } from "@/lib/models";
import { listOpenRouterModels, type OpenRouterModel } from "@/lib/api/admin";

import { AskUserForm } from "./AskUserForm";
import { buildThread, type StreamingAssistant } from "./buildThread";
import { Composer, type ComposerAttachment } from "./Composer";
import { ConversationTitle } from "./ConversationTitle";
import { CostCounter } from "./CostCounter";
import { LlmCallTrace } from "./LlmCallTrace";
import { listConversationLlmCalls } from "@/lib/api/llm-calls";
import type { MsgStats } from "./Message";
import { ContextMeter } from "./ContextMeter";
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
  const router = useRouter();
  const [forking, setForking] = React.useState(false);
  const abortRef = React.useRef<AbortController | null>(null);
  const stopTurn = React.useCallback(() => { abortRef.current?.abort(); }, []);

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
  // A mid-turn ``ask_user`` question the agent is blocked on. While set, the composer stays disabled
  // and the AskUserForm is the input; answering (or cancelling) POSTs back and the turn streams on.
  const [pendingPrompt, setPendingPrompt] = React.useState<{ promptId: string; field: AskField } | null>(null);
  const [inFlight, setInFlight] = React.useState(false);
  const [lastUserMessageId, setLastUserMessageId] = React.useState<
    string | null
  >(null);
  // Per-conversation model choice (a matbot provider name); persisted client-side.
  const [provider, setProvider] = React.useState("");
  React.useEffect(() => {
    setProvider(loadProvider(conversationId));
    setPendingPrompt(null); // a parked question never carries across conversations
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

  // Per-response telemetry: sum each turn's llm_calls (classifiers + primary) by message id so the
  // compact line under each answer shows provider/model + tokens + cost. Re-fetched after every turn.
  const [llmStats, setLlmStats] = React.useState<Map<string, MsgStats>>(new Map());
  const reloadLlmStats = React.useCallback(async () => {
    if (!config) return;
    try {
      const calls = await listConversationLlmCalls(conversationId);
      const m = new Map<string, MsgStats>();
      for (const c of calls) {
        if (!c.message_id) continue;
        const s = m.get(c.message_id) ?? { provider: c.provider, model: c.model, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 };
        s.input += c.input_tokens; s.output += c.output_tokens;
        s.cacheRead += c.cache_read_tokens; s.cacheCreation += c.cache_creation_tokens;
        s.cost += c.cost_usd;
        // Label by the primary call (the user-facing answer), not a classifier/sizer sub-call.
        if (c.role === "primary") { s.provider = c.provider; s.model = c.model; }
        m.set(c.message_id, s);
      }
      setLlmStats(m);
    } catch {
      /* telemetry is a nicety — a failed fetch just leaves the lines absent */
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

  // Refresh the per-response telemetry on open and after every committed turn.
  React.useEffect(() => {
    void reloadLlmStats();
  }, [reloadLlmStats, turnRefreshKey]);

  const onSubmit = React.useCallback(
    async (text: string, attachments?: ComposerAttachment[], compare?: string[]) => {
      if (!config) throw new Error("auth config not ready");
      setPendingUserText(text);
      setStreamingAssistant({ text: "", interrupted: false, toolCalls: [] });
      setPendingPrompt(null);
      setInFlight(true);

      // Reduce the AG-UI event stream (#263) into the optimistic
      // streaming-assistant row: text deltas append to the bubble, tool
      // calls accumulate and render live (#265/#267), and ``complete``
      // hands back the persisted ids that trigger the history re-fetch.
      const ensure = (prev: StreamingAssistant | null): StreamingAssistant =>
        prev ?? { text: "", interrupted: false, toolCalls: [] };

      let completed = false;
      // Abortable so a wedged/never-ending turn can be stopped from the UI (the composer is disabled
      // while a turn is in flight, so a stuck turn would otherwise lock the conversation — this is the
      // "prompts vanishing on long turns" recovery). Aborting throws into the catch → cleanup below.
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        for await (const event of streamTurn({
          conversationId,
          text,
          signal: ac.signal,
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
          } else if (event.kind === "ask_user") {
            // The agent paused to ask the user something; render the form and wait. The stream stays
            // open (blocked server-side in the tool) — answering POSTs back and these events resume.
            setPendingPrompt({ promptId: event.prompt_id, field: event.field });
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

      setPendingPrompt(null); // the turn ended (or broke) — no question is awaiting an answer now
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

  // "Second opinion": explicitly invoke the (now opt-in) Inner voice skill on the latest answer. The
  // skill no longer auto-fires, so the button sends a clear instruction to load + apply it. Reuses the
  // normal turn path; the request reads naturally in history.
  const onSecondOpinion = React.useCallback(() => {
    if (inFlight) return;
    void onSubmit(
      'Give me a second opinion on your previous response: load your "Inner voice" skill (skill_action ' +
        'load) and use it to critique and sharpen that answer, then return the improved version.',
    );
  }, [inFlight, onSubmit]);

  // Summarise & continue: when a thread gets long (heavy on context/tokens), distil it into a brief and
  // spin up a fresh conversation IN THE SAME FOLDER seeded with that brief — so you keep the thread of
  // thought but reset the context window. Orchestrated client-side over the normal turn/create/move
  // endpoints; both helper turns run silently (their text isn't streamed into this view).
  const summariseAndFork = React.useCallback(async () => {
    if (forking || inFlight) return;
    setForking(true);
    try {
      let summary = "";
      for await (const ev of streamTurn({
        conversationId,
        text: "Summarise our conversation so far into a concise continuation brief for a fresh thread: the goal, the key decisions and facts established, the current state, and the open next steps. Output ONLY the brief in markdown, no preamble.",
        ...(provider ? { provider } : {}),
      })) {
        if (ev.kind === "text") summary += ev.delta;
      }
      summary = summary.trim();
      if (!summary) throw new Error("could not generate a summary");

      let folderId: string | null = null;
      try { folderId = (await fetchConversation(conversationId)).folder_id ?? null; } catch { /* place at root */ }

      const created = await createConversation(`${title ?? "Chat"} (continued)`);
      const newId = created.id;
      if (folderId) { try { await moveConversationToFolder(newId, folderId); } catch { /* leave unfiled */ } }

      // Seed the fresh thread with the brief (drain the stream; the ack lands as the first exchange).
      for await (const _ of streamTurn({
        conversationId: newId,
        text: `This thread continues a previous conversation. Continuation brief:\n\n${summary}\n\n---\nReply only with "Ready to continue where we left off." and wait for my next message.`,
        ...(provider ? { provider } : {}),
      })) { void _; }

      router.push(`/c/${newId}`);
    } catch (e) {
      setHistoryError(e instanceof Error ? e.message : "summarise & continue failed");
    } finally {
      setForking(false);
    }
  }, [forking, inFlight, conversationId, provider, title, router]);

  // Settle a parked ask_user prompt. Clear it optimistically (the form vanishes immediately); the
  // turn's open SSE stream delivers whatever the agent does next once the engine unblocks the tool.
  const respondToPrompt = React.useCallback(
    async (answer: string, cancel?: boolean) => {
      setPendingPrompt((p) => {
        if (p) {
          void answerPrompt({
            conversationId,
            promptId: p.promptId,
            ...(cancel ? { cancel: true } : { answer }),
          }).catch(() => {
            // The turn stream surfaces a real failure; nothing to recover here.
          });
        }
        return null;
      });
    },
    [conversationId],
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

  // Context fullness for the meter: the largest turn's input context (prompt + cache-read tokens, which
  // still occupy the window). Context grows over a conversation, so the max ≈ the latest turn. Plain
  // computation (not a hook) — this runs after the component's early returns.
  const ctx = ((): { used: number; model: string | null } => {
    let used = 0;
    let model: string | null = null;
    for (const s of llmStats.values()) {
      const u = s.input + s.cacheRead;
      if (u > used) { used = u; model = s.model; }
    }
    return { used, model };
  })();

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
          <Thread messages={messages} onSecondOpinion={onSecondOpinion} busy={inFlight} statsByMessage={llmStats} />
        )}
        {pendingPrompt ? (
          <AskUserForm
            field={pendingPrompt.field}
            onAnswer={(a) => void respondToPrompt(a)}
            onCancel={() => void respondToPrompt("", true)}
          />
        ) : null}
        {traceOpen ? (
          <div style={{ marginTop: "var(--s5)", borderTop: "1px solid var(--border)", paddingTop: "var(--s4)" }}>
            <LlmCallTrace
              conversationId={conversationId}
              refreshKey={turnRefreshKey}
            />
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-end gap-3 px-1 pb-0.5">
        {inFlight ? (
          <button
            type="button"
            onClick={stopTurn}
            title="Stop this turn (recover a stuck/long-running response)"
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            ■ Stop
          </button>
        ) : null}
        {messages.length > 1 ? (
          <button
            type="button"
            onClick={() => void summariseAndFork()}
            disabled={forking || inFlight}
            title="Summarise this conversation and continue in a fresh thread (same folder) to reset the context window"
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            {forking ? "Summarising…" : "⑂ Summarise & continue"}
          </button>
        ) : null}
        <ContextMeter used={ctx.used} model={ctx.model} />
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

