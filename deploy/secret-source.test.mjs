// SPDX-License-Identifier: AGPL-3.0-or-later
// Tests for the pluggable SecretSource. Run: node --test deploy/secret-source.test.mjs
// (sops source shells to the `sops` binary and isn't exercised here.)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeSource, parseKv, presentOf } from "./secret-source.mjs";

describe("parseKv", () => {
  it("parses KEY=value lines (incl. export, ignores comments)", () => {
    assert.deepEqual(parseKv("A=1\nexport B=two\n# c\nC="), { A: "1", B: "two", C: "" });
  });
  it("parses a JSON object", () => {
    assert.deepEqual(parseKv('{"A":"1","N":2,"X":null}'), { A: "1", N: "2", X: "" });
  });
});

describe("presentOf", () => {
  it("returns keys with non-empty values only", () => {
    const p = presentOf({ A: "1", B: "", C: "  " });
    assert.ok(p.has("A")); assert.ok(!p.has("B")); assert.ok(!p.has("C"));
  });
});

describe("makeSource: dotenv (default)", () => {
  it("reads root + web .env files", () => {
    const root = mkdtempSync(join(tmpdir(), "eidan-src-"));
    writeFileSync(join(root, ".env"), "DATABASE_URL=pg://x\n");
    mkdirSync(join(root, "apps/web"), { recursive: true });
    writeFileSync(join(root, "apps/web/.env"), "EIDAN_ENGINE_URL=http://e\n");
    const s = makeSource({}, root);
    assert.equal(s.kind, "dotenv");
    assert.equal(s.resolve("root").DATABASE_URL, "pg://x");
    assert.equal(s.resolve("web").EIDAN_ENGINE_URL, "http://e");
  });
});

describe("makeSource: exec (universal adapter)", () => {
  it("runs the configured command per file and parses its output", () => {
    const s = makeSource({ secrets: { source: "exec", command: { root: "printf 'A=1\\nB=2\\n'" } } }, "/tmp");
    assert.equal(s.kind, "exec");
    assert.deepEqual(s.resolve("root"), { A: "1", B: "2" });
    assert.deepEqual(s.resolve("web"), {}); // no command for web
  });
});

describe("makeSource: unknown", () => {
  it("throws a clear error", () => {
    assert.throws(() => makeSource({ secrets: { source: "nope" } }, "/tmp"), /dotenv \| sops \| exec/);
  });
});
