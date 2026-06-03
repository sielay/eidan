// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";

import { previewResult } from "./ToolDisclosure";

describe("previewResult", () => {
  it("returns empty string for a null result", () => {
    expect(previewResult(null)).toBe("");
  });

  it("returns short results verbatim (whitespace collapsed)", () => {
    expect(previewResult("ok")).toBe("ok");
    expect(previewResult("  many   spaces\nhere  ")).toBe("many spaces here");
  });

  it("truncates long results with a single-char ellipsis", () => {
    const long = "x".repeat(200);
    const out = previewResult(long);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith("…")).toBe(true);
  });
});
