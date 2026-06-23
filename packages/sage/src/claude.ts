// SPDX-License-Identifier: AGPL-3.0-or-later
// Subprocess wrapper for the `claude` CLI — port of eidan_claude.shell. Single chokepoint:
// runs `claude --print --output-format stream-json --verbose --dangerously-skip-permissions`
// in the caller's cwd and consumes the NDJSON event stream. Inactivity + hard-cap watchdogs;
// retryable-phrase detection; env filtered to a safe subset with GH_TOKEN stripped so a claude
// run that bash-invokes `gh` cannot inherit the host PAT. Audit-row telemetry (plugin_claude.runs)
// is dropped from the port — the loop's own pr_iterations/findings carry the story.
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import * as readline from 'node:readline';

export type ClaudeOutcome = 'success' | 'error' | 'inactivity_timeout' | 'hard_cap';

export interface ClaudeRunResult {
  exitCode: number;
  durationMs: number;
  finalText: string; // tail of accumulated assistant text (or the `result` event)
  toolUseCount: number;
  toolNames: string[];
  retryable: boolean;
  outcome: ClaudeOutcome;
  stderrTail: string;
}

// Forwarded to the child. Anything else (GH_TOKEN, AWS_*, …) is dropped.
const PASSTHROUGH = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_COLLATE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
];
const STRIP = new Set(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']);

const RETRYABLE_PHRASES = [
  'rate limit', 'rate_limit', 'usage limit', 'usage_limit', 'max plan', 'limit reached',
  'too many requests', '429', 'quota', 'tokens exceeded', 'context length',
  'out of extra usage', 'out of usage', "you're out of", 'resets at', 'resets in',
];

export function isRetryable(stderr: string, assistantText = ''): boolean {
  const blob = `${stderr ?? ''}\n${assistantText ?? ''}`.toLowerCase();
  if (!blob.trim()) return false;
  return RETRYABLE_PHRASES.some((p) => blob.includes(p));
}

function buildArgv(prompt: string, model?: string, system?: string, pluginDir?: string): string[] {
  const argv = ['--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  // Vendored ponytail plugin (vendor/ponytail) — loaded for this session only, no install/marketplace.
  // Its SessionStart hook injects the "lazy senior dev" ruleset into context. See config.ponytailDir.
  if (pluginDir) argv.push('--plugin-dir', pluginDir);
  if (model) argv.push('--model', model);
  if (system) argv.push('--append-system-prompt', system);
  argv.push(prompt);
  return argv;
}

function buildEnv(oauthToken?: string, ponytailMode?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of PASSTHROUGH) {
    if (k in process.env && !STRIP.has(k)) env[k] = process.env[k];
  }
  if (oauthToken) env['CLAUDE_CODE_OAUTH_TOKEN'] = oauthToken;
  // Intensity for the vendored ponytail plugin (lite|full|ultra); read by its activate hook.
  if (ponytailMode) env['PONYTAIL_DEFAULT_MODE'] = ponytailMode;
  env['CLAUDE_NO_UPDATE_NOTIFIER'] = '1';
  return env;
}

interface ClaudeEvent { type?: string; message?: { content?: Array<Record<string, unknown>> }; result?: unknown }

function eventText(ev: ClaudeEvent): string {
  if (ev.type !== 'assistant') return '';
  const parts: string[] = [];
  for (const block of ev.message?.content ?? []) {
    if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text']) parts.push(block['text']);
  }
  return parts.join('\n');
}

function eventToolName(ev: ClaudeEvent): string | null {
  if (ev.type !== 'assistant') return null;
  for (const block of ev.message?.content ?? []) {
    if (block['type'] === 'tool_use') return (block['name'] as string) || 'tool';
  }
  return null;
}

export interface ClaudeRunOpts {
  binPath: string;
  prompt: string;
  cwd: string;
  model?: string | undefined;
  system?: string | undefined;
  oauthToken?: string | undefined;
  pluginDir?: string | undefined; // vendored ponytail plugin dir; undefined → no --plugin-dir
  ponytailMode?: string | undefined; // lite|full|ultra → PONYTAIL_DEFAULT_MODE
  inactivityTimeoutMs?: number | undefined; // default 300_000
  hardCapMs?: number | undefined; // default 1_800_000
  maxOutputTail?: number | undefined; // default 4096 chars
  onEvent?: ((ev: ClaudeEvent) => void) | undefined;
}

function tail(s: string, n: number): string {
  return s.length <= n ? s : s.slice(s.length - n);
}

export async function runClaude(opts: ClaudeRunOpts): Promise<ClaudeRunResult> {
  const inactivityMs = opts.inactivityTimeoutMs ?? 300_000;
  const hardCapMs = opts.hardCapMs ?? 1_800_000;
  const maxTail = opts.maxOutputTail ?? 4096;

  if (!existsSync(opts.cwd) || !statSync(opts.cwd).isDirectory()) {
    throw new Error(`claude.bad_cwd: ${opts.cwd}`);
  }

  const started = Date.now();
  const child = spawn(opts.binPath, buildArgv(opts.prompt, opts.model, opts.system, opts.pluginDir), {
    cwd: opts.cwd,
    env: buildEnv(opts.oauthToken, opts.ponytailMode),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const textParts: string[] = [];
  let resultText: string | null = null;
  let toolUseCount = 0;
  const toolNames: string[] = [];
  let stderrBuf = '';
  let lastLineAt = Date.now();
  let inactivityKilled = false;

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    lastLineAt = Date.now();
    const trimmed = line.trim();
    if (!trimmed) return;
    let ev: ClaudeEvent | null = null;
    try { ev = JSON.parse(trimmed) as ClaudeEvent; } catch { return; }
    const t = eventText(ev);
    if (t) textParts.push(t);
    const tool = eventToolName(ev);
    if (tool) { toolUseCount += 1; toolNames.push(tool); }
    if (ev.type === 'result' && typeof ev.result === 'string' && ev.result.trim()) resultText = ev.result;
    opts.onEvent?.(ev);
  });
  child.stderr.on('data', (d: Buffer) => {
    stderrBuf = tail(stderrBuf + d.toString('utf8'), 64 * 1024);
  });

  const spawnErr = new Promise<never>((_, reject) => {
    child.on('error', (e: NodeJS.ErrnoException) => {
      reject(e.code === 'ENOENT' ? new Error(`claude.binary_missing: ${opts.binPath}`) : e);
    });
  });

  let outcome: ClaudeOutcome;
  const exited = new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1)));

  // Watchdogs: inactivity (stdout silence) + hard wall-clock cap.
  let inactivityTimer: NodeJS.Timeout | undefined;
  const armInactivity = (): void => {
    if (inactivityMs <= 0) return;
    const tick = Math.max(Math.min(inactivityMs / 4, 30_000), 50);
    inactivityTimer = setInterval(() => {
      if (Date.now() - lastLineAt > inactivityMs) {
        inactivityKilled = true;
        clearInterval(inactivityTimer);
        child.kill('SIGKILL');
      }
    }, tick);
  };
  armInactivity();
  const hardCap = new Promise<'hard_cap'>((resolve) => {
    setTimeout(() => { child.kill('SIGKILL'); resolve('hard_cap'); }, hardCapMs).unref();
  });

  try {
    const winner = await Promise.race([exited.then((c) => ({ code: c })), hardCap, spawnErr]);
    if (winner === 'hard_cap') {
      await exited;
      outcome = 'hard_cap';
    } else {
      const code = (winner as { code: number }).code;
      outcome = code === 0 ? 'success' : 'error';
    }
  } finally {
    if (inactivityTimer) clearInterval(inactivityTimer);
    rl.close();
  }

  if (inactivityKilled && outcome !== 'hard_cap') outcome = 'inactivity_timeout';

  const exitCode = child.exitCode ?? -1;
  const finalText = resultText ?? textParts.join('\n');
  const retryable = outcome !== 'success' && isRetryable(stderrBuf, finalText);

  return {
    exitCode,
    durationMs: Date.now() - started,
    finalText: tail(finalText, maxTail),
    toolUseCount,
    toolNames,
    retryable,
    outcome,
    stderrTail: tail(stderrBuf, 2048),
  };
}

// Probe whether a usable `claude` binary exists — the node is host-gated on this (Pi-only in the
// current deploy; Fly nodes reboot too often for ~/.claude/ to survive). Returns the resolved path
// or null. EIDAN_CLAUDE_BIN overrides; otherwise we trust PATH resolution at spawn time and just
// report 'claude'.
export function resolveClaudeBin(): string | null {
  const explicit = process.env['EIDAN_CLAUDE_BIN']?.trim();
  if (explicit) return existsSync(explicit) ? explicit : null;
  return 'claude'; // resolved on PATH at spawn; a missing binary surfaces as claude.binary_missing
}
