// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MessageRow } from "@/lib/api/conversations";

import type { PairedToolCall, ThreadMessage } from "./Thread";

const PENDING_USER_ID = "pending-user";
const PENDING_ASSISTANT_ID = "pending-assistant";

/**
 * A tool call as it streams in live (#263 / #267), before the turn's
 * rows are persisted and re-fetched. ``args_text`` accumulates the
 * AG-UI ``TOOL_CALL_ARGS`` delta(s); ``result`` is ``null`` until the
 * ``TOOL_CALL_RESULT`` lands.
 */
export interface LiveToolCall {
  tool_call_id: string;
  tool_name: string;
  args_text: string;
  result: string | null;
}

export interface StreamingAssistant {
  text: string;
  interrupted: boolean;
  toolCalls: LiveToolCall[];
}

export interface BuildThreadInput {
  history: MessageRow[] | null;
  pendingUserText: string | null;
  streamingAssistant: StreamingAssistant | null;
}

/**
 * Best-effort parse of a live tool call's accumulated argument JSON.
 * The backend sends the whole argument object in one ``TOOL_CALL_ARGS``
 * frame, so this normally parses cleanly; while a frame is mid-flight
 * (or a tool takes no args) we fall back to an empty object so the
 * call still renders.
 */
// Extract the persisted ⑂ Compare legs from an assistant row's metadata.fork, if present + well-formed.
// Each leg may include truncation status and token usage metadata.
function forkFrom(row: MessageRow): { legs: Array<{ model: string; text: string; truncated?: boolean; inputTokens?: number; outputTokens?: number }> } | undefined {
  const f = (row.metadata as { fork?: unknown } | null)?.fork as { legs?: unknown } | undefined;
  if (!f || !Array.isArray(f.legs)) return undefined;
  const legs = f.legs
    .filter((l): l is { model: string; text: string; truncated?: boolean; inputTokens?: number; outputTokens?: number } => {
      const leg = l as { model?: unknown; text?: unknown; truncated?: unknown; inputTokens?: unknown; outputTokens?: unknown };
      return !!l && typeof leg.model === "string" && typeof leg.text === "string";
    });
  return legs.length ? { legs } : undefined;
}

function parseToolArgs(argsText: string): Record<string, unknown> {
  if (!argsText) return {};
  try {
    const parsed: unknown = JSON.parse(argsText);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Fold the flat history into the assistant-rooted tree the UI renders.
 *
 * Per `docs/014 §4.2`, consecutive ``role='tool'`` rows fold under the
 * preceding assistant row that issued them: the assistant's
 * ``tool_calls`` are paired with the following tool rows' results by
 * ``tool_use_id``, and the tool rows themselves are dropped from the
 * top-level message list. The optimistic streaming rows (pending user,
 * streaming assistant) are appended last.
 */
export function buildThread({
  history,
  pendingUserText,
  streamingAssistant,
}: BuildThreadInput): ThreadMessage[] {
  const out: ThreadMessage[] = [];

  if (history) {
    let i = 0;
    while (i < history.length) {
      const row = history[i];

      if (row.role === "assistant" && row.tool_calls.length > 0) {
        // Gather the immediately-following consecutive tool rows.
        // Eidan writes one tool row per loop iteration today, but a
        // future change could batch differently — consume all of them
        // so the pairing stays honest either way.
        const results: Map<string, { content: string; is_error: boolean }> =
          new Map();
        let j = i + 1;
        while (j < history.length && history[j].role === "tool") {
          for (const r of history[j].tool_results) {
            results.set(r.tool_use_id, {
              content: r.content,
              is_error: r.is_error,
            });
          }
          j++;
        }
        const pairs: PairedToolCall[] = row.tool_calls
          // ask_user is surfaced as an interactive form (AskUserForm), not a folded tool-call audit
          // row — hide the raw call/result so the Q&A doesn't also appear as opaque JSON.
          .filter((call) => call.name !== "ask_user")
          .map((call) => {
            const matched = results.get(call.id);
            return {
              id: call.id,
              name: call.name,
              input: call.input,
              result: matched?.content ?? null,
              is_error: matched?.is_error ?? false,
            };
          });
        out.push({
          id: row.id,
          role: "assistant",
          content: row.content,
          tool_calls: pairs,
          created_at: row.created_at,
        });
        i = j;
        continue;
      }

      if (row.role === "tool") {
        // Orphan tool row — no preceding assistant claimed it. Skip:
        // there is nothing meaningful to fold it under, and the spec
        // is explicit that tool rows render under their issuer.
        i++;
        continue;
      }

      out.push({
        id: row.id,
        role: row.role,
        content: row.content,
        created_at: row.created_at,
        ...(row.role === "assistant" ? { fork: forkFrom(row) } : {}),
      });
      i++;
    }
  }

  if (pendingUserText !== null) {
    out.push({
      id: PENDING_USER_ID,
      role: "user",
      content: pendingUserText,
    });
  }
  if (streamingAssistant !== null) {
    const livePairs: PairedToolCall[] = streamingAssistant.toolCalls
      .filter((tc) => tc.tool_name !== "ask_user") // rendered as the interactive form, not a tool row
      .map((tc) => ({
        id: tc.tool_call_id,
        name: tc.tool_name,
        input: parseToolArgs(tc.args_text),
        result: tc.result,
        is_error: false,
      }));
    out.push({
      id: PENDING_ASSISTANT_ID,
      role: "assistant",
      content: streamingAssistant.text,
      tool_calls: livePairs.length > 0 ? livePairs : undefined,
      streaming: !streamingAssistant.interrupted,
      interrupted: streamingAssistant.interrupted,
    });
  }
  return out;
}
