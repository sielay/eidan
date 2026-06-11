// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import type { MessageRow } from "@/lib/api/conversations";

import { buildThread } from "./buildThread";

/**
 * Fold-and-pair behaviour for the thread renderer (`docs/014 §4.2`).
 * The persisted shape this is built on top of is fixed by
 * `eidan_backend.persistence.insert_assistant_message` and
 * `insert_tool_message`: assistant rows carry ``tool_calls`` with
 * ``{id, name, input}``; tool rows carry ``tool_results`` with
 * ``{tool_use_id, content, is_error}``; ``tool_use_id`` joins to ``id``.
 */

function row(partial: Partial<MessageRow> & Pick<MessageRow, "id" | "role">): MessageRow {
  return {
    content: null,
    tool_calls: [],
    tool_results: [],
    parent_message_id: null,
    provider: null,
    model: null,
    metadata: null,
    created_at: "2026-05-22T10:00:00Z",
    ...partial,
  };
}

describe("buildThread", () => {
  it("returns an empty list for empty input", () => {
    expect(
      buildThread({ history: null, pendingUserText: null, streamingAssistant: null }),
    ).toEqual([]);
    expect(
      buildThread({ history: [], pendingUserText: null, streamingAssistant: null }),
    ).toEqual([]);
  });

  it("passes plain user + assistant rows through unchanged", () => {
    const out = buildThread({
      history: [
        row({ id: "u1", role: "user", content: "hi" }),
        row({ id: "a1", role: "assistant", content: "hello" }),
      ],
      pendingUserText: null,
      streamingAssistant: null,
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: "u1", role: "user", content: "hi" });
    expect(out[1]).toMatchObject({ id: "a1", role: "assistant", content: "hello" });
    expect(out[1].tool_calls).toBeUndefined();
  });

  it("pairs an assistant turn's tool calls with the following tool row's results", () => {
    const out = buildThread({
      history: [
        row({
          id: "a1",
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "tc_1", name: "search", input: { q: "weather" } },
            { id: "tc_2", name: "fetch_url", input: { url: "https://example.com" } },
          ],
        }),
        row({
          id: "t1",
          role: "tool",
          tool_results: [
            { tool_use_id: "tc_1", content: "sunny", is_error: false },
            { tool_use_id: "tc_2", content: "<html>", is_error: false },
          ],
        }),
        row({ id: "a2", role: "assistant", content: "It's sunny." }),
      ],
      pendingUserText: null,
      streamingAssistant: null,
    });

    expect(out).toHaveLength(2);
    expect(out[0].id).toBe("a1");
    expect(out[0].tool_calls).toEqual([
      {
        id: "tc_1",
        name: "search",
        input: { q: "weather" },
        result: "sunny",
        is_error: false,
      },
      {
        id: "tc_2",
        name: "fetch_url",
        input: { url: "https://example.com" },
        result: "<html>",
        is_error: false,
      },
    ]);
    expect(out[1]).toMatchObject({ id: "a2", role: "assistant", content: "It's sunny." });
  });

  it("propagates is_error from the tool result onto the paired call", () => {
    const out = buildThread({
      history: [
        row({
          id: "a1",
          role: "assistant",
          tool_calls: [{ id: "tc_1", name: "db_query", input: { sql: "SELECT 1/0" } }],
        }),
        row({
          id: "t1",
          role: "tool",
          tool_results: [{ tool_use_id: "tc_1", content: "division by zero", is_error: true }],
        }),
      ],
      pendingUserText: null,
      streamingAssistant: null,
    });
    expect(out).toHaveLength(1);
    expect(out[0].tool_calls?.[0]).toMatchObject({
      name: "db_query",
      result: "division by zero",
      is_error: true,
    });
  });

  it("folds a multi-iteration loop: each assistant turn pairs only its own tool row", () => {
    const out = buildThread({
      history: [
        row({
          id: "a1",
          role: "assistant",
          tool_calls: [{ id: "tc_1", name: "search", input: { q: "x" } }],
        }),
        row({
          id: "t1",
          role: "tool",
          tool_results: [{ tool_use_id: "tc_1", content: "r1", is_error: false }],
        }),
        row({
          id: "a2",
          role: "assistant",
          tool_calls: [{ id: "tc_2", name: "fetch_url", input: { url: "u" } }],
        }),
        row({
          id: "t2",
          role: "tool",
          tool_results: [{ tool_use_id: "tc_2", content: "r2", is_error: false }],
        }),
        row({ id: "a3", role: "assistant", content: "done." }),
      ],
      pendingUserText: null,
      streamingAssistant: null,
    });
    expect(out.map((m) => m.id)).toEqual(["a1", "a2", "a3"]);
    expect(out[0].tool_calls?.[0].result).toBe("r1");
    expect(out[1].tool_calls?.[0].result).toBe("r2");
    expect(out[2].tool_calls).toBeUndefined();
  });

  it("consumes multiple consecutive tool rows under one assistant", () => {
    // Defensive: insert_tool_message writes one row per iteration today,
    // but the spec talks about *consecutive* tool rows folding together.
    const out = buildThread({
      history: [
        row({
          id: "a1",
          role: "assistant",
          tool_calls: [
            { id: "tc_1", name: "tool_a", input: {} },
            { id: "tc_2", name: "tool_b", input: {} },
          ],
        }),
        row({
          id: "t1",
          role: "tool",
          tool_results: [{ tool_use_id: "tc_1", content: "r1", is_error: false }],
        }),
        row({
          id: "t2",
          role: "tool",
          tool_results: [{ tool_use_id: "tc_2", content: "r2", is_error: false }],
        }),
      ],
      pendingUserText: null,
      streamingAssistant: null,
    });
    expect(out).toHaveLength(1);
    expect(out[0].tool_calls?.map((c) => [c.name, c.result])).toEqual([
      ["tool_a", "r1"],
      ["tool_b", "r2"],
    ]);
  });

  it("leaves an unpaired call's result null when no tool row matches", () => {
    const out = buildThread({
      history: [
        row({
          id: "a1",
          role: "assistant",
          tool_calls: [{ id: "tc_ghost", name: "search", input: {} }],
        }),
        row({ id: "a2", role: "assistant", content: "next turn" }),
      ],
      pendingUserText: null,
      streamingAssistant: null,
    });
    expect(out[0].tool_calls?.[0]).toMatchObject({
      name: "search",
      result: null,
      is_error: false,
    });
  });

  it("drops orphan tool rows (no preceding assistant tool_calls)", () => {
    const out = buildThread({
      history: [
        row({
          id: "t1",
          role: "tool",
          tool_results: [{ tool_use_id: "tc_orphan", content: "x", is_error: false }],
        }),
        row({ id: "a1", role: "assistant", content: "hi" }),
      ],
      pendingUserText: null,
      streamingAssistant: null,
    });
    expect(out.map((m) => m.id)).toEqual(["a1"]);
  });

  it("appends the optimistic pending pair after history", () => {
    const out = buildThread({
      history: [row({ id: "u1", role: "user", content: "hi" })],
      pendingUserText: "follow up",
      streamingAssistant: { text: "thinking", interrupted: false, toolCalls: [] },
    });
    expect(out.map((m) => m.id)).toEqual([
      "u1",
      "pending-user",
      "pending-assistant",
    ]);
    expect(out[2]).toMatchObject({
      role: "assistant",
      content: "thinking",
      streaming: true,
      interrupted: false,
    });
  });

  it("renders live tool calls on the streaming assistant row (#267)", () => {
    const out = buildThread({
      history: null,
      pendingUserText: "search please",
      streamingAssistant: {
        text: "on it",
        interrupted: false,
        toolCalls: [
          {
            tool_call_id: "tc1",
            tool_name: "search",
            args_text: '{"q":"x"}',
            result: '{"r":1}',
          },
          // A call still in flight — no result yet, args mid-stream.
          {
            tool_call_id: "tc2",
            tool_name: "fetch",
            args_text: "",
            result: null,
          },
        ],
      },
    });
    const assistant = out[out.length - 1];
    expect(assistant.id).toBe("pending-assistant");
    expect(assistant.tool_calls).toEqual([
      {
        id: "tc1",
        name: "search",
        input: { q: "x" },
        result: '{"r":1}',
        is_error: false,
      },
      {
        id: "tc2",
        name: "fetch",
        input: {}, // empty args parse to {} so the call still renders
        result: null,
        is_error: false,
      },
    ]);
  });
});
