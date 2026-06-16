// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure unit tests for the node-config drift helpers. Run: node --test deploy/node-config.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parsePlugins, intendedPlugins, pluginDrift, renderNodeYaml, parseEnvKeys, envDrift,
} from "./node-config.mjs";

const ASSEMBLED = [
  "principal: eidan-operator",
  "plugins:",
  "  - ./packages/storage-postgres # storage backend first",
  "  - ./packages/jobs # work-queue",
  "  - ./packages/frontend-telegram # inbound telegram",
  "  - ./packages/sage # eidan-bundle: sage (kind=code)",
  "providers:",
  "  - anthropic",
].join("\n");

describe("parsePlugins", () => {
  it("extracts the packages/<name> basenames, ignoring non-plugin lines", () => {
    assert.deepEqual(parsePlugins(ASSEMBLED),
      ["storage-postgres", "jobs", "frontend-telegram", "sage"]);
  });
  it("returns [] for yaml with no plugin lines", () => {
    assert.deepEqual(parsePlugins("providers:\n  - anthropic\n"), []);
  });
});

describe("intendedPlugins", () => {
  it("subtracts the node's role-disables", () => {
    assert.deepEqual(intendedPlugins(ASSEMBLED, ["sage", "frontend-telegram"]),
      ["storage-postgres", "jobs"]);
  });
  it("with no disables is the full assembled set", () => {
    assert.deepEqual(intendedPlugins(ASSEMBLED),
      ["storage-postgres", "jobs", "frontend-telegram", "sage"]);
  });
});

describe("pluginDrift", () => {
  it("flags intended-but-absent as missing and node-only as extra", () => {
    const intended = ["storage-postgres", "jobs", "sage"];
    const actual = ["storage-postgres", "jobs", "routines"]; // sage missing, routines stale
    assert.deepEqual(pluginDrift(intended, actual), { missing: ["sage"], extra: ["routines"] });
  });
  it("clean when sets match regardless of order", () => {
    assert.deepEqual(pluginDrift(["a", "b"], ["b", "a"]), { missing: [], extra: [] });
  });
});

describe("renderNodeYaml", () => {
  it("strips only the disabled plugin lines, preserving everything else verbatim", () => {
    const out = renderNodeYaml(ASSEMBLED, ["sage"]);
    assert.ok(!out.includes("packages/sage"));
    assert.ok(out.includes("packages/storage-postgres"));
    assert.ok(out.includes("providers:"));
    assert.deepEqual(parsePlugins(out), ["storage-postgres", "jobs", "frontend-telegram"]);
  });
  it("is a no-op (full set) with no disables", () => {
    assert.equal(renderNodeYaml(ASSEMBLED), ASSEMBLED);
  });
});

describe("parseEnvKeys / envDrift", () => {
  it("reads key names from EnvironmentFile / export lines, never values", () => {
    const env = "EIDAN_JOB_KINDS=chat,code\nexport ANTHROPIC_API_KEY=sk-secret\n# comment\nBLANK=\n";
    assert.deepEqual(parseEnvKeys(env).sort(),
      ["ANTHROPIC_API_KEY", "BLANK", "EIDAN_JOB_KINDS"]);
  });
  it("envDrift reports only the absent declared keys", () => {
    assert.deepEqual(
      envDrift(["EIDAN_JOB_KINDS", "ANTHROPIC_API_KEY"], ["EIDAN_JOB_KINDS"]),
      { missing: ["ANTHROPIC_API_KEY"] });
  });
});
