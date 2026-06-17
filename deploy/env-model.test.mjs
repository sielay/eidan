// SPDX-License-Identifier: AGPL-3.0-or-later
// Tests for the schema-driven env model. Run: node --test deploy/env-model.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveNodeEnv, missingValues, undeclaredKeys, presentKeysOf, parseEnvMap,
  renderEnv, genSecret, renderExample, scaffoldEnv, validateFile,
} from "./env-model.mjs";

const CONFIG = { targets: { kesha: { type: "ssh-node", env_set: { EIDAN_NODE_ID: "kesha" } } } };

describe("resolveNodeEnv", () => {
  it("tags schema keys vs topology overrides, and reflects value presence", () => {
    const r = resolveNodeEnv(CONFIG, "kesha", new Set(["DATABASE_URL"]));
    assert.equal(r.DATABASE_URL.source, "schema");
    assert.equal(r.DATABASE_URL.present, true);
    assert.equal(r.EIDAN_GH_PATS.source, "schema");        // worker key, from .env
    assert.equal(r.EIDAN_GH_PATS.present, false);
    assert.equal(r.EIDAN_JOB_KINDS.source, "derived");     // compiled from the manifest, not .env
    assert.equal(r.EIDAN_NODE_ID.source, "override");
    assert.equal(r.EIDAN_NODE_ID.present, true);
  });
});

describe("missingValues / undeclaredKeys", () => {
  it("missingValues lists schema keys without a value (not overrides)", () => {
    const r = resolveNodeEnv(CONFIG, "fly", new Set(["DATABASE_URL"]));
    const miss = missingValues(r);
    assert.ok(miss.includes("EIDAN_AUTH_MASTER_KEY"));
    assert.ok(!miss.includes("DATABASE_URL"));
  });
  it("undeclaredKeys finds node-actual keys not in the target's set", () => {
    const r = resolveNodeEnv(CONFIG, "kesha", new Set());
    assert.deepEqual(undeclaredKeys(r, ["DATABASE_URL", "LEGACY_THING"]), ["LEGACY_THING"]);
  });
});

describe("renderEnv", () => {
  it("emits schema values + env_set literals, omits valueless (-> missing)", () => {
    const { text, missing } = renderEnv(CONFIG, "kesha", { DATABASE_URL: "pg://x", EIDAN_JOB_KINDS: "chat,code" });
    assert.match(text, /^DATABASE_URL=pg:\/\/x$/m);
    assert.match(text, /^EIDAN_NODE_ID=kesha$/m);   // override literal
    assert.ok(missing.includes("EIDAN_AUTH_MASTER_KEY")); // declared, no value
    assert.ok(!/EIDAN_AUTH_MASTER_KEY=/.test(text));
  });
});

describe("genSecret", () => {
  it("hex:32 -> 64 hex chars; base64:48 -> urlsafe base64", () => {
    assert.match(genSecret("hex:32"), /^[0-9a-f]{64}$/);
    assert.match(genSecret("base64:48"), /^[A-Za-z0-9_-]+$/);
    assert.equal(genSecret(null), null);
  });
});

describe("renderExample", () => {
  it("root example has engine keys + annotations, no web-only keys", () => {
    const ex = renderExample("root");
    assert.match(ex, /^DATABASE_URL=/m);
    assert.match(ex, /\[req\]/);
    assert.ok(!/NEXT_PUBLIC_APP_URL=/.test(ex));
  });
  it("web example has web keys only (derived keys excluded)", () => {
    const ex = renderExample("web");
    assert.match(ex, /^EIDAN_DATABASE_URL=/m);           // web key, non-derived
    assert.ok(!/ANTHROPIC_API_KEY=/.test(ex));           // engine-only
    assert.ok(!/^EIDAN_ENGINE_URL=/m.test(ex));          // derived -> excluded
  });
});

describe("scaffoldEnv", () => {
  it("auto-generates secrets, applies defaults, FILL-marks required externals, keeps existing", () => {
    const { text, generated } = scaffoldEnv("root", { DATABASE_URL: "pg://keep" });
    assert.ok(generated.includes("EIDAN_AUTH_MASTER_KEY")); // generated
    assert.match(text, /^DATABASE_URL=pg:\/\/keep$/m);      // preserved
    assert.match(text, /^EIDAN_AUTH_ALLOWED_EMAIL=‹FILL/m); // required external (non-derived)
    assert.ok(!/^EIDAN_WEB_URL=/m.test(text));              // derived -> NOT scaffolded into .env
  });
});

describe("validateFile", () => {
  it("reports missing required + leftover placeholders", () => {
    const { missingRequired, placeholders } = validateFile("root", { DATABASE_URL: "pg://x", EIDAN_WEB_URL: "‹FILL: x›" });
    assert.ok(missingRequired.includes("EIDAN_AUTH_MASTER_KEY"));
    assert.ok(placeholders.includes("EIDAN_WEB_URL"));
  });
});

describe("parsing", () => {
  it("presentKeysOf ignores empties; parseEnvMap keeps values", () => {
    assert.ok(presentKeysOf("A=1\nB=\n").has("A"));
    assert.ok(!presentKeysOf("A=1\nB=\n").has("B"));
    assert.deepEqual(parseEnvMap("A=1\nB=two"), { A: "1", B: "two" });
  });
});
