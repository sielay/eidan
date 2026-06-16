// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-node config rendering + drift detection for ssh-node deploys.
//
// The recurring deploy pain: each node's own matbot.yaml (the plugin list) is hand-maintained and
// silently drifts from the assembled canary config. `assemble` folds a bundle into
// infra/fly-mb/matbot.yaml and the ssh-node deploy rsyncs its files to the node — but it never syncs
// the node's matbot.yaml, so the plugin won't actually LOAD until someone hand-edits the node's yaml.
// That gap caused the mail-plugins-missing and routines/telegram-manual-add incidents.
//
// These pure helpers derive the *intended* plugin set for a node from the assembled matbot.yaml
// minus that node's declared role-disables (nodes differ by role: Fly is the API/UI backend with
// claude/git/sage off; kesha runs the sage `code` worker). With "intended" in hand, drift is either
// reported (`check`) or closed (`deploy --sync-config`). No values are ever read here — env handling
// is key-names-only by construction.

// Extract plugin dir basenames from a matbot.yaml `plugins:` block:
//   "  - ./packages/storage-postgres # comment"  ->  "storage-postgres"
export function parsePlugins(yamlText) {
  const out = [];
  for (const line of yamlText.split("\n")) {
    const m = /^\s*-\s+\.\/packages\/([A-Za-z0-9_.-]+)/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

// The plugin set a node SHOULD load = the assembled set minus the node's role-disables.
export function intendedPlugins(assembledYaml, disable = []) {
  const dis = new Set(disable);
  return parsePlugins(assembledYaml).filter((p) => !dis.has(p));
}

// Compare intended vs the node's actual plugin list -> a drift report.
//   missing: assembled-and-intended but NOT loaded on the node (the silent-drift failure)
//   extra:   loaded on the node but not intended (stale / hand-added / now-disabled)
export function pluginDrift(intended, actual) {
  const have = new Set(actual);
  const want = new Set(intended);
  return {
    missing: intended.filter((p) => !have.has(p)),
    extra: actual.filter((p) => !want.has(p)),
  };
}

// Render the intended node matbot.yaml = the assembled yaml with disabled plugin lines stripped.
// Everything else (providers, env interpolation, comments) is preserved verbatim from the assembled
// base, so a synced node yaml stays a faithful subset of the canary config.
export function renderNodeYaml(assembledYaml, disable = []) {
  const dis = new Set(disable);
  return assembledYaml
    .split("\n")
    .filter((line) => {
      const m = /^\s*-\s+\.\/packages\/([A-Za-z0-9_.-]+)/.exec(line);
      return !(m && dis.has(m[1]));
    })
    .join("\n");
}

// Env key NAMES only — never values. Parse `KEY=...` / `export KEY=...` (systemd EnvironmentFile or
// shell). Used for env drift: "is every key this node needs actually set?" without reading secrets.
export function parseEnvKeys(envText) {
  const out = new Set();
  for (const line of envText.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=/.exec(line);
    if (m) out.add(m[1]);
  }
  return [...out];
}

// Which declared env keys are absent on the node (names only).
export function envDrift(intendedKeys = [], actualKeys = []) {
  const have = new Set(actualKeys);
  return { missing: intendedKeys.filter((k) => !have.has(k)) };
}
