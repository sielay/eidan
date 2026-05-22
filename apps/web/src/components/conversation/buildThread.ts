import type { MessageRow } from "@/lib/api/conversations";

import type { PairedToolCall, ThreadMessage } from "./Thread";

const PENDING_USER_ID = "pending-user";
const PENDING_ASSISTANT_ID = "pending-assistant";

export interface BuildThreadInput {
  history: MessageRow[] | null;
  pendingUserText: string | null;
  streamingAssistant: { text: string; interrupted: boolean } | null;
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
        const pairs: PairedToolCall[] = row.tool_calls.map((call) => {
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
    out.push({
      id: PENDING_ASSISTANT_ID,
      role: "assistant",
      content: streamingAssistant.text,
      streaming: !streamingAssistant.interrupted,
      interrupted: streamingAssistant.interrupted,
    });
  }
  return out;
}
