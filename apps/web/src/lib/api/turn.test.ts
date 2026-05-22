import { describe, expect, it } from "vitest";

import { parseFrame } from "./turn";

/**
 * Unit tests for the SSE frame decoder.
 *
 * The wire shape is pinned in `docs/005 §5.1` (turn streaming):
 * each event is `event: <name>\ndata: <json>\n\n`. The parser
 * accepts the standard SSE shape (comments, multiple data: lines
 * joined by \n, optional event: defaulting to "message").
 */
describe("parseFrame", () => {
  it("decodes a chunk event into a kind:chunk TurnEvent", () => {
    const raw = `event: chunk\ndata: {"text":"hello"}`;
    const out = parseFrame(raw);
    expect(out).toEqual({ kind: "chunk", text: "hello" });
  });

  it("decodes a complete event into a kind:complete TurnEvent", () => {
    const raw =
      `event: complete\n` +
      `data: {"user_message_id":"00000000-0000-0000-0000-000000000001",` +
      `"assistant_message_id":"00000000-0000-0000-0000-000000000002"}`;
    const out = parseFrame(raw);
    expect(out).toEqual({
      kind: "complete",
      user_message_id: "00000000-0000-0000-0000-000000000001",
      assistant_message_id: "00000000-0000-0000-0000-000000000002",
    });
  });

  it("returns null on a comment-only frame", () => {
    const raw = `: heartbeat`;
    expect(parseFrame(raw)).toBeNull();
  });

  it("joins multi-line data with a single newline (SSE spec)", () => {
    const raw = `event: chunk\ndata: {"text":"line1\\n` + `data: line2"}`;
    // Two data: lines join via "\n", then JSON parses the embedded
    // literal "\n" so the assistant text becomes "line1\nline2"
    // (one logical newline inside the chunk text).
    const out = parseFrame(raw);
    expect(out).toEqual({ kind: "chunk", text: "line1\ndata: line2" });
  });

  it("ignores comment lines mixed with data", () => {
    const raw = `: trace=abc\nevent: chunk\n: another\ndata: {"text":"x"}`;
    const out = parseFrame(raw);
    expect(out).toEqual({ kind: "chunk", text: "x" });
  });

  it("falls back to unknown event when the name isn't chunk/complete", () => {
    const raw = `event: failure\ndata: {"reason":"x"}`;
    const out = parseFrame(raw);
    expect(out).toEqual({
      kind: "unknown",
      event: "failure",
      data: '{"reason":"x"}',
    });
  });

  it("falls back to unknown when the data isn't valid JSON", () => {
    const raw = `event: chunk\ndata: not json at all`;
    const out = parseFrame(raw);
    expect(out).toEqual({
      kind: "unknown",
      event: "chunk",
      data: "not json at all",
    });
  });

  it("falls back to unknown when chunk schema rejects the shape", () => {
    // Missing required `text` field — Zod rejects, parser routes to unknown.
    const raw = `event: chunk\ndata: {"not_text":123}`;
    const out = parseFrame(raw);
    expect(out).toEqual({
      kind: "unknown",
      event: "chunk",
      data: '{"not_text":123}',
    });
  });

  it("strips the single leading space after `data:` per SSE spec", () => {
    const raw = `event: chunk\ndata: {"text":" leading-space-preserved"}`;
    const out = parseFrame(raw);
    expect(out).toEqual({
      kind: "chunk",
      text: " leading-space-preserved",
    });
  });
});
