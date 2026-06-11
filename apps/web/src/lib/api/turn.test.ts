// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { parseFrame } from "./turn";

/**
 * Unit tests for the AG-UI SSE frame decoder (#263 / #267).
 *
 * AG-UI frames are a single ``data: {json}`` line per event (no named
 * ``event:`` line); the event name lives in the JSON ``type`` field and
 * payload keys are camelCase. ``parseFrame`` decodes one frame into the
 * app's slim, snake_case :type:`TurnEvent` union.
 */
describe("parseFrame", () => {
  it("decodes TEXT_MESSAGE_CONTENT into a kind:text event", () => {
    const raw = `data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1","delta":"hello"}`;
    expect(parseFrame(raw)).toEqual({ kind: "text", delta: "hello" });
  });

  it("decodes the tool-call quartet (start/args/result)", () => {
    expect(
      parseFrame(
        `data: {"type":"TOOL_CALL_START","toolCallId":"tc1","toolCallName":"search"}`,
      ),
    ).toEqual({ kind: "tool_call_start", tool_call_id: "tc1", tool_name: "search" });

    expect(
      parseFrame(
        `data: {"type":"TOOL_CALL_ARGS","toolCallId":"tc1","delta":"{\\"q\\":\\"x\\"}"}`,
      ),
    ).toEqual({ kind: "tool_call_args", tool_call_id: "tc1", args_delta: '{"q":"x"}' });

    expect(
      parseFrame(
        `data: {"type":"TOOL_CALL_RESULT","messageId":"mr1","toolCallId":"tc1","content":"{\\"r\\":1}"}`,
      ),
    ).toEqual({ kind: "tool_call_result", tool_call_id: "tc1", content: '{"r":1}' });
  });

  it("decodes RUN_FINISHED, lifting persisted ids off result", () => {
    const raw =
      `data: {"type":"RUN_FINISHED","threadId":"c1","runId":"r1",` +
      `"result":{"user_message_id":"00000000-0000-0000-0000-000000000001",` +
      `"assistant_message_id":"00000000-0000-0000-0000-000000000002","iterations":2}}`;
    expect(parseFrame(raw)).toEqual({
      kind: "complete",
      user_message_id: "00000000-0000-0000-0000-000000000001",
      assistant_message_id: "00000000-0000-0000-0000-000000000002",
    });
  });

  it("decodes RUN_ERROR into a kind:error event", () => {
    const raw = `data: {"type":"RUN_ERROR","message":"boom"}`;
    expect(parseFrame(raw)).toEqual({ kind: "error", message: "boom" });
  });

  it("passes RUN_STARTED (and any unrendered type) through as unknown", () => {
    const raw = `data: {"type":"RUN_STARTED","threadId":"c1","runId":"r1"}`;
    expect(parseFrame(raw)).toEqual({ kind: "unknown", type: "RUN_STARTED" });
  });

  it("returns null on a comment-only / keep-alive frame", () => {
    expect(parseFrame(`: heartbeat`)).toBeNull();
  });

  it("returns null when the data isn't valid JSON", () => {
    expect(parseFrame(`data: not json at all`)).toBeNull();
  });

  it("ignores comment lines mixed with the data line", () => {
    const raw = `: trace=abc\ndata: {"type":"TEXT_MESSAGE_CONTENT","delta":"x"}`;
    expect(parseFrame(raw)).toEqual({ kind: "text", delta: "x" });
  });

  it("strips the single leading space after `data:` per SSE spec", () => {
    const raw = `data: {"type":"TEXT_MESSAGE_CONTENT","delta":" leading-space"}`;
    expect(parseFrame(raw)).toEqual({ kind: "text", delta: " leading-space" });
  });
});
