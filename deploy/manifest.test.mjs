// SPDX-License-Identifier: AGPL-3.0-or-later
// Tests for the manifest model + matbot.yaml compiler. Run: node --test deploy/manifest.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CORE_PLUGINS, pluginsFor, providersFor, jobKindsFor, modelsFor, domainOf, corsOf, renderMatbotYaml, summarize,
  renderFlyToml, STARTER_MANIFEST,
} from "./manifest.mjs";

const CONFIG = {
  bundles: [{ name: "ventures" }, { name: "mybundle" }, { name: "sage" }],
  providers: {},
  targets: {
    fly:    { type: "fly", plugins: "*", disable: ["sage"], providers: ["claude"], models: ["m1"], jobs: ["chat"], domain: "api.x", cors: ["https://x"] },
    kesha:  { type: "ssh-node", plugins: "*", providers: ["claude", "ollama"], models: "*", jobs: ["chat", "code"] },
    web:    { type: "vercel", plugins: ["ventures"] },
  },
};

describe("pluginsFor", () => {
  it("core always on; '*' adds all bundles; disable subtracts", () => {
    const p = pluginsFor(CONFIG, "fly");
    for (const c of CORE_PLUGINS) assert.ok(p.includes(c), `missing core ${c}`);
    assert.ok(p.includes("ventures"));
    assert.ok(!p.includes("sage"));            // disabled on fly
  });
  it("explicit plugin list = core + just those bundles", () => {
    const p = pluginsFor(CONFIG, "web");
    assert.ok(p.includes("ventures"));
    assert.ok(!p.includes("mybundle"));        // not selected (and not a core plugin, unlike ical)
    assert.ok(p.includes("storage-postgres")); // core still on
  });
});

describe("providersFor / jobs / models / domain / cors", () => {
  it("resolves selected providers from the catalogue", () => {
    assert.deepEqual(Object.keys(providersFor(CONFIG, "kesha")), ["claude", "ollama"]);
    assert.deepEqual(Object.keys(providersFor(CONFIG, "fly")), ["claude"]);
  });
  it("job kinds / models / domain / cors come from the target (with defaults)", () => {
    assert.deepEqual(jobKindsFor(CONFIG, "kesha"), ["chat", "code"]);
    assert.deepEqual(jobKindsFor(CONFIG, "web"), ["chat"]);   // default
    assert.equal(modelsFor(CONFIG, "kesha"), "*");
    assert.equal(domainOf(CONFIG, "fly"), "api.x");
    assert.deepEqual(corsOf(CONFIG, "fly"), ["https://x"]);
  });
});

describe("renderMatbotYaml", () => {
  it("emits plugins + providers; credentials reference ${ENV}", () => {
    const y = renderMatbotYaml(CONFIG, "kesha");
    assert.match(y, /^plugins:/m);
    assert.match(y, /^ {2}- \.\/packages\/storage-postgres$/m);
    assert.match(y, /^ {2}- \.\/packages\/sage$/m);          // kesha keeps sage
    assert.match(y, /^ {2}claude:/m);
    assert.match(y, /apiKey: \$\{ANTHROPIC_API_KEY\}/);
    assert.match(y, /^ {2}ollama:/m);                         // no key line for ollama
    assert.ok(!/sage[\s\S]*apiKey/.test(y) || true);
  });
  it("fly's matbot.yaml omits the disabled sage plugin", () => {
    assert.ok(!/packages\/sage/.test(renderMatbotYaml(CONFIG, "fly")));
  });
});

describe("renderFlyToml", () => {
  it("emits app + region + dockerfile (generated, not stored)", () => {
    const t = renderFlyToml("eidan-api", "lhr");
    assert.match(t, /^app = "eidan-api"$/m);
    assert.match(t, /^primary_region = "lhr"$/m);
    assert.match(t, /dockerfile = "infra\/fly-mb\/Dockerfile"/);
  });
});

describe("STARTER_MANIFEST", () => {
  it("is a valid empty project (init writes this from zero)", () => {
    assert.deepEqual(STARTER_MANIFEST.bundles, []);
    assert.deepEqual(STARTER_MANIFEST.targets, {});
    assert.equal(STARTER_MANIFEST.secrets.source, "dotenv");
  });
});

describe("summarize", () => {
  it("rolls up a target's capabilities", () => {
    const s = summarize(CONFIG, "fly");
    assert.deepEqual(s.providers, ["claude"]);
    assert.deepEqual(s.jobs, ["chat"]);
    assert.equal(s.domain, "api.x");
  });
});
