// SPDX-License-Identifier: AGPL-3.0-or-later
// OpenRouter cheap-model self-review — port of selfreview.py (005 §7, Phase B step 6). An
// independent second opinion on a PR diff via a cheap model, deliberately separate from the node's
// Anthropic `claude` conductor. The loop falls back to this when Copilot never engages, so a CI-less
// Copilot-less repo can still settle. Gated on OPENROUTER_API_KEY — no key → loadConfig returns null
// and the loop keeps waiting for Copilot (status quo, no regression). Never throws: failures map to
// verdict='error' and the loop retries next tick.
import { parseConcerns, type Concern } from './critic.js';

const DEFAULT_MODEL = 'google/gemini-2.5-flash';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_TIMEOUT_MS = 120_000;
const BLOCKING = new Set(['error', 'warning']);

export interface SelfReviewConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
}

export interface SelfReviewResult {
  verdict: 'approve' | 'request_changes' | 'error';
  concerns: Concern[];
  model: string;
  detail: string;
}

export function loadSelfReviewConfig(): SelfReviewConfig | null {
  const key = process.env['OPENROUTER_API_KEY']?.trim();
  if (!key) return null;
  const model = process.env['EIDAN_SAGE_SELFREVIEW_MODEL']?.trim() || DEFAULT_MODEL;
  const baseUrl = (process.env['OPENROUTER_BASE_URL']?.trim() || DEFAULT_BASE_URL).replace(/\/$/, '');
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const raw = process.env['EIDAN_OPENAI_TIMEOUT_SECONDS']?.trim();
  if (raw) {
    const v = Number.parseFloat(raw);
    // Cap at 300s — a huge coding-run value is absurd for one cheap review call and would stall the tick.
    if (Number.isFinite(v) && v > 0) timeoutMs = Math.min(v, 300) * 1000;
  }
  return { apiKey: key, model, baseUrl, timeoutMs };
}

export function verdictFor(concerns: Concern[]): 'approve' | 'request_changes' {
  return concerns.some((c) => BLOCKING.has(c.severity)) ? 'request_changes' : 'approve';
}

export function blockingConcerns(concerns: Concern[]): Concern[] {
  return concerns.filter((c) => BLOCKING.has(c.severity));
}

function buildPrompt(opts: { taskPrompt: string; repo: string; prNumber: number; diff: string }): string {
  return (
    "You are sage's independent second-opinion reviewer for a pull request. A separate pre-PR critic " +
    'already ran; you are a cheap, independent cross-check standing in for an external code reviewer ' +
    'that is unavailable.\n\n' +
    'Review the diff for correctness bugs, security problems, and clear regressions. Be conservative: ' +
    'only flag issues you are confident are real problems in THIS diff. Pure style preferences are at ' +
    'most `note` severity.\n\n' +
    'Output ONLY a fenced ```json array (no prose). Each element: ' +
    '{"severity": "error"|"warning"|"note", "kind": string, "file": string|null, "line": integer|null, ' +
    '"message": string, "suggested_fix": string|null}. ' +
    'An empty array [] means you found nothing — a valid, expected outcome for a small, correct change.\n\n' +
    `PR #${opts.prNumber} on ${opts.repo}.\n` +
    `What the PR set out to do:\n${opts.taskPrompt || '(no task prompt recorded)'}\n\n` +
    `Diff under review:\n${opts.diff}\n`
  );
}

async function chatCompletion(cfg: SelfReviewConfig, prompt: string): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
  try {
    const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'eidan-sage self-review',
      },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }], temperature: 0 }),
      signal: ac.signal,
    });
    if (!resp.ok) throw new Error(`OpenRouter HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const choices = data.choices ?? [];
    if (!choices.length) throw new Error('OpenRouter response had no choices');
    return String(choices[0]?.message?.content ?? '');
  } finally {
    clearTimeout(timer);
  }
}

// Run the self-review. Never raises — HTTP/parse failures come back as verdict='error'.
export async function runSelfReview(
  cfg: SelfReviewConfig,
  opts: { taskPrompt: string; repo: string; prNumber: number; diff: string },
): Promise<SelfReviewResult> {
  const prompt = buildPrompt(opts);
  let raw: string;
  try {
    raw = await chatCompletion(cfg, prompt);
  } catch (e) {
    console.warn(`[sage] self-review call failed for ${opts.repo}#${opts.prNumber} via ${cfg.model}: ${e instanceof Error ? e.message : String(e)}`);
    return { verdict: 'error', concerns: [], model: cfg.model, detail: String(e).slice(0, 200) };
  }
  let concerns: Concern[];
  try {
    concerns = parseConcerns(raw);
  } catch (e) {
    console.warn(`[sage] self-review output from ${cfg.model} did not parse for ${opts.repo}#${opts.prNumber}: ${e instanceof Error ? e.message : String(e)}`);
    return { verdict: 'error', concerns: [], model: cfg.model, detail: String(e).slice(0, 200) };
  }
  return { verdict: verdictFor(concerns), concerns, model: cfg.model, detail: '' };
}
