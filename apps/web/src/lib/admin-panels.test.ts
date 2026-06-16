// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { parsePanels } from "./admin-panels";

describe("parsePanels", () => {
  it("returns empty for absent/blank input", () => {
    expect(parsePanels(undefined)).toEqual([]);
    expect(parsePanels("")).toEqual([]);
    expect(parsePanels("   ")).toEqual([]);
  });

  it("parses name=prefix pairs", () => {
    expect(parsePanels("sage=/api/sage")).toEqual([{ plugin: "sage", prefix: "/api/sage" }]);
    expect(parsePanels("sage=/api/sage, business=/api/charles")).toEqual([
      { plugin: "sage", prefix: "/api/sage" },
      { plugin: "business", prefix: "/api/charles" },
    ]);
  });

  it("derives the name from a bare prefix (last path segment)", () => {
    expect(parsePanels("/api/sage")).toEqual([{ plugin: "sage", prefix: "/api/sage" }]);
    expect(parsePanels("/api/admin/coding")).toEqual([{ plugin: "coding", prefix: "/api/admin/coding" }]);
  });

  it("strips trailing slashes from the prefix", () => {
    expect(parsePanels("sage=/api/sage/")).toEqual([{ plugin: "sage", prefix: "/api/sage" }]);
    expect(parsePanels("/api/sage/")).toEqual([{ plugin: "sage", prefix: "/api/sage" }]);
  });

  it("tolerates surrounding whitespace and empty entries", () => {
    expect(parsePanels("  sage = /api/sage ,, business=/api/charles ")).toEqual([
      { plugin: "sage", prefix: "/api/sage" },
      { plugin: "business", prefix: "/api/charles" },
    ]);
  });

  it("drops entries whose prefix is not an absolute path", () => {
    expect(parsePanels("foo=bar")).toEqual([]);
    expect(parsePanels("relative")).toEqual([]);
    expect(parsePanels("ok=/api/ok, bad=nope")).toEqual([{ plugin: "ok", prefix: "/api/ok" }]);
  });
});
