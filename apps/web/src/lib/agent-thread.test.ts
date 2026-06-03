// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";

import {
  filterMatches,
  parseAgentName,
} from "./agent-thread";

describe("parseAgentName", () => {
  it("extracts the lowercased name from a `[name] ...` prefix", () => {
    expect(parseAgentName("[git] sielay/eidan-sage#8 (sage)")).toBe("git");
    expect(parseAgentName("[sentry] hot_pattern")).toBe("sentry");
  });

  it("returns null when the title is missing a prefix", () => {
    expect(parseAgentName("Recipe for granola")).toBeNull();
    expect(parseAgentName("Untitled")).toBeNull();
  });

  it("returns null when the prefix doesn't match the plugin-id pattern", () => {
    // Uppercase chars fail the regex (plugin ids are kebab/digits).
    expect(parseAgentName("[Git] thing")).toBeNull();
    // Empty brackets, lone brackets, prefix-only — all null.
    expect(parseAgentName("[]")).toBeNull();
    expect(parseAgentName("[git")).toBeNull();
    expect(parseAgentName("git]")).toBeNull();
  });

  it("tolerates leading whitespace", () => {
    expect(parseAgentName("  [git] poll tick")).toBe("git");
  });

  it("handles null / undefined / non-string input as null", () => {
    expect(parseAgentName(null)).toBeNull();
    expect(parseAgentName(undefined)).toBeNull();
    expect(parseAgentName(123 as unknown as string)).toBeNull();
  });

  it("requires the bracket to be followed by whitespace or end-of-line", () => {
    // No separator after the closing bracket — likely a free-form
    // title that happens to start with brackets. Treat as not-agent.
    expect(parseAgentName("[draft]final.md")).toBeNull();
    // Bracket immediately at end of string is still an agent thread —
    // sentry's empty-body case. Allow it.
    expect(parseAgentName("[sentry]")).toBe("sentry");
  });
});

describe("filterMatches", () => {
  it("`all` accepts every row regardless of agent name", () => {
    expect(filterMatches("all", null)).toBe(true);
    expect(filterMatches("all", "git")).toBe(true);
  });

  it("`agents` accepts only rows with an agent name", () => {
    expect(filterMatches("agents", null)).toBe(false);
    expect(filterMatches("agents", "git")).toBe(true);
    expect(filterMatches("agents", "sentry")).toBe(true);
  });

  it("`chats` accepts only rows with no agent name", () => {
    expect(filterMatches("chats", null)).toBe(true);
    expect(filterMatches("chats", "git")).toBe(false);
  });
});
