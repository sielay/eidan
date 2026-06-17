// SPDX-License-Identifier: AGPL-3.0-or-later
// Tests for the env catalog. Run: node --test deploy/env-schema.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keysForTarget, requiredForTarget, crossTargetShared, specOf, TARGETS } from "./env-schema.mjs";

const names = (t) => keysForTarget(t).map((e) => e.key);

describe("keysForTarget", () => {
  it("fly gets engine keys + its pinned key, but NOT worker keys", () => {
    const k = names("fly");
    assert.ok(k.includes("DATABASE_URL"));
    assert.ok(k.includes("EIDAN_COMPANIES_HOUSE_KEY")); // roles:['fly']
    assert.ok(!k.includes("EIDAN_JOB_KINDS"));          // worker-only
    assert.ok(!k.includes("NEXT_PUBLIC_APP_URL"));      // web-only
  });
  it("ssh-node gets engine + worker keys", () => {
    const k = names("ssh-node");
    assert.ok(k.includes("DATABASE_URL"));      // engine
    assert.ok(k.includes("EIDAN_JOB_KINDS"));   // worker
    assert.ok(!k.includes("NEXT_PUBLIC_APP_URL"));
  });
  it("vercel gets web keys + the shared auth trio, no engine-only keys", () => {
    const k = names("vercel");
    assert.ok(k.includes("EIDAN_ENGINE_URL"));
    assert.ok(k.includes("EIDAN_AUTH_JWT_SECRET")); // shared with engine
    assert.ok(!k.includes("ANTHROPIC_API_KEY"));    // engine-only
  });
});

describe("requiredForTarget", () => {
  it("fly requires the core infra keys, but NOT a specific provider key or derived keys", () => {
    const r = requiredForTarget("fly");
    for (const k of ["DATABASE_URL", "EIDAN_AUTH_MASTER_KEY", "EIDAN_AUTH_JWT_SECRET", "EIDAN_AUTH_ALLOWED_EMAIL"])
      assert.ok(r.includes(k), `missing required ${k}`);
    assert.ok(!r.includes("ANTHROPIC_API_KEY"), "provider key is conditional, not required");
    assert.ok(!r.includes("EIDAN_WEB_URL"), "derived keys aren't .env-required");
  });
});

describe("crossTargetShared", () => {
  it("flags the auth trio as must-match across targets", () => {
    const s = crossTargetShared();
    for (const k of ["EIDAN_AUTH_JWT_SECRET", "EIDAN_AUTH_MASTER_KEY", "EIDAN_AUTH_ALLOWED_EMAIL"])
      assert.ok(s.includes(k), `${k} should be cross-target`);
  });
});

describe("specOf / TARGETS", () => {
  it("looks up a key's metadata", () => {
    assert.equal(specOf("EIDAN_AUTH_MASTER_KEY").generate, "base64:48");
    assert.equal(specOf("EIDAN_AUTH_JWT_SECRET").generate, "hex:32");
    assert.equal(specOf("nope"), null);
  });
  it("maps targets to files", () => {
    assert.equal(TARGETS.fly.file, "root");
    assert.equal(TARGETS.vercel.file, "web");
  });
});
