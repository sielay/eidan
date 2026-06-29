// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { MessageBlock, type MsgStats } from "./Message";

/**
 * One tool call paired with its matching tool result, ready to fold
 * under the assistant turn that issued it (`docs/014 §4.2`).
 * ``result`` is ``null`` when the pairing failed (orphan call) — the
 * UI shows the call without a result panel in that case.
 */
export interface PairedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result: string | null;
  is_error: boolean;
}

export interface ThreadMessage {
  /** Backend-assigned id, or a synthetic ``pending-…`` id for in-flight rows. */
  id: string;
  role: "user" | "assistant" | "tool";
  /** Null for tool-call-only assistant turns — `eidan.messages.content` is nullable. */
  content: string | null;
  /**
   * Folded tool calls + paired results for this assistant turn, per
   * `docs/014 §4.2`. Empty / undefined when the turn issued no tools.
   */
  tool_calls?: PairedToolCall[];
  /** True only for the assistant row currently being streamed. */
  streaming?: boolean;
  /** True when the stream ended without a ``complete`` event. */
  interrupted?: boolean;
  /** ISO timestamp of the persisted row (undefined for optimistic/streaming rows). */
  created_at?: string;
  /** ⑂ Compare: persisted candidate legs (from the assistant row's metadata.fork). */
  fork?: { legs: Array<{ model: string; text: string }> };
}

export interface ThreadProps {
  messages: ThreadMessage[];
  /** Re-run the Inner voice skill on the latest assistant answer (opt-in second opinion). */
  onSecondOpinion?: (() => void) | undefined;
  /** Disable the second-opinion affordance while a turn is streaming. */
  busy?: boolean | undefined;
  /** Per-assistant-message telemetry (provider/model/tokens/cost), keyed by message id. */
  statsByMessage?: Map<string, MsgStats> | undefined;
}

/**
 * The conversation transcript.
 *
 * Auto-scrolls to the newest message when the list grows or the last
 * row's content changes (the streaming case). This keeps the active
 * assistant chunk in view without fighting a user who has scrolled up
 * to read history — the effect only runs when the *last* row mutates.
 */
export function Thread({ messages, onSecondOpinion, busy, statsByMessage }: ThreadProps): React.ReactElement {
  const bottomRef = React.useRef<HTMLDivElement | null>(null);
  // The second-opinion button only makes sense on the most recent finished assistant answer.
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && !m.streaming && m.content && m.content.length > 0) { lastAssistantIdx = i; break; }
  }
  const lastSignature =
    messages.length > 0
      ? `${messages[messages.length - 1].id}:${messages[messages.length - 1].content?.length ?? 0}`
      : "empty";

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lastSignature]);

  if (messages.length === 0) {
    return (
      <div className="empty">
        <div className="empty__title">A calm, capable assistant</div>
        <div className="empty__body">
          Ask anything — eidan remembers what matters and can act on your
          behalf. Say hi to get started.
        </div>
      </div>
    );
  }

  return (
    <div className="thread">
      {messages.map((m, i) => (
        <MessageBlock
          key={m.id}
          role={m.role}
          content={m.content}
          toolCalls={m.tool_calls}
          streaming={m.streaming}
          interrupted={m.interrupted}
          time={m.created_at}
          fork={m.fork}
          onSecondOpinion={i === lastAssistantIdx ? onSecondOpinion : undefined}
          secondOpinionBusy={busy}
          stats={m.role === "assistant" ? statsByMessage?.get(m.id) : undefined}
        />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
