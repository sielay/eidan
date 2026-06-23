// SPDX-License-Identifier: AGPL-3.0-or-later
// Env-derived loop config — port of the IterationConfig the Python plugin builds at activation.
// Same env names so an operator's topology extra_env carries over unchanged.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveClaudeBin } from './claude.js';

const PONYTAIL_MODES = new Set(['lite', 'full', 'ultra']);

// Resolve the vendored ponytail plugin (packages/sage/vendor/ponytail), runtime-relative to this
// module (src/): the dir (for --plugin-dir, which exposes the /ponytail-review etc. skills), the
// active intensity, and the ruleset `system` text. EIDAN_SAGE_PONYTAIL: default 'full'; 'off' disables;
// an unrecognised value falls back to 'full'. A stripped checkout (no dir/AGENTS.md) degrades to nulls.
//
// NB: --plugin-dir alone does NOT bias the coder — the plugin's SessionStart hook does not inject its
// ruleset in non-interactive `claude --print` runs (verified on-host), it only makes the skills
// invokable. So we ALSO append the ruleset (vendor/ponytail/AGENTS.md) via --append-system-prompt,
// which is deterministic in --print and is what actually puts the coder in lazy-senior-dev mode.
export function resolvePonytail(): { dir: string | null; mode: string | undefined; system: string | undefined } {
  const off = { dir: null, mode: undefined, system: undefined };
  const raw = process.env['EIDAN_SAGE_PONYTAIL']?.trim().toLowerCase();
  if (raw === 'off') return off;
  const mode = raw && PONYTAIL_MODES.has(raw) ? raw : 'full';
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'ponytail');
  if (!existsSync(dir)) return off;
  let system: string | undefined;
  try {
    system = `PONYTAIL MODE ACTIVE — level: ${mode}\n\n${readFileSync(join(dir, 'AGENTS.md'), 'utf8')}`;
  } catch {
    return off; // ruleset missing → don't claim ponytail is on
  }
  return { dir, mode, system };
}

export interface SageConfig {
  nodeId: string;
  defaultBase: string;
  notifyTopic: string;
  maxIterations: number;
  concurrency: number;
  staleInterval: string; // Postgres interval; must exceed a fix's hard cap or a live iteration is yanked
  pollIntervalMs: number;
  claudeBinPath: string | null;
  ponytailDir: string | null; // vendored ponytail plugin dir, or null when disabled/absent
  ponytailMode: string | undefined; // lite|full|ultra
  ponytailSystem: string | undefined; // ruleset for --append-system-prompt (what actually biases the coder)
  fixModel?: string | undefined;
  triageModel?: string | undefined;
  oauthToken?: string | undefined;
  inactivityTimeoutMs: number;
  hardCapMs: number;
  maxOutputTail: number;
}

function intEnv(key: string, dflt: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return dflt;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : dflt;
}
function floatEnv(key: string, dfltSec: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return dfltSec;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : dfltSec;
}

export function loadConfig(): SageConfig {
  const defaultModel = process.env['EIDAN_CLAUDE_DEFAULT_MODEL']?.trim() || undefined;
  const ponytail = resolvePonytail();
  return {
    nodeId: process.env['EIDAN_NODE_ID']?.trim() || `mb-${crypto.randomUUID().slice(0, 8)}`,
    defaultBase: process.env['EIDAN_SAGE_DEFAULT_BASE']?.trim() || 'main',
    // Defaults to job.update (Slack-routed on every node that set EIDAN_NOTIFY_ROUTES). A node whose
    // topology routes a dedicated topic sets EIDAN_SAGE_NOTIFY_TOPIC — the channel never lives here.
    notifyTopic: process.env['EIDAN_SAGE_NOTIFY_TOPIC']?.trim() || 'job.update',
    maxIterations: intEnv('EIDAN_SAGE_LOOP_MAX_ITERATIONS', 5),
    concurrency: intEnv('EIDAN_SAGE_LOOP_CONCURRENCY', 2),
    staleInterval: process.env['EIDAN_SAGE_LOOP_STALE']?.trim() || 'PT45M',
    pollIntervalMs: floatEnv('EIDAN_SAGE_POLL_INTERVAL', 60) * 1000,
    claudeBinPath: resolveClaudeBin(),
    ponytailDir: ponytail.dir,
    ponytailMode: ponytail.mode,
    ponytailSystem: ponytail.system,
    fixModel: process.env['EIDAN_SAGE_FIX_MODEL']?.trim() || defaultModel,
    triageModel: process.env['EIDAN_SAGE_TRIAGE_MODEL']?.trim() || defaultModel,
    oauthToken: process.env['EIDAN_CLAUDE_OAUTH_TOKEN']?.trim() || undefined,
    inactivityTimeoutMs: floatEnv('EIDAN_CLAUDE_INACTIVITY_TIMEOUT', 300) * 1000,
    hardCapMs: floatEnv('EIDAN_CLAUDE_HARD_CAP', 1800) * 1000,
    maxOutputTail: intEnv('EIDAN_CLAUDE_MAX_OUTPUT_TAIL', 4096),
  };
}
