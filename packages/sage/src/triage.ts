// SPDX-License-Identifier: AGPL-3.0-or-later
// Triage prompt rendering + verdict parsing — port of triage.py. Render a markdown template, run it
// through `claude`, parse a single fenced-JSON array out of the reply. Strict on shape, lenient on
// content: one malformed row is dropped (warn), the batch still succeeds; a hard parse failure throws.

export const COPILOT_VERDICTS = new Set(['fix', 'reply', 'ack', 'escalate']);
export const CI_VERDICTS = new Set(['autofix', 'fix', 'escalate']);

export interface Verdict {
  ref: string; // thread id (copilot) or check name (ci) — the join key
  verdict: string;
  reason: string;
  fixHint: string | null;
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

// Substitute {{ key }} placeholders; a placeholder naming a key not in `mapping` is left verbatim.
export function render(template: string, mapping: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (whole, key: string) => (key in mapping ? mapping[key]! : whole));
}

// Reuse the critic's extractors: a fenced ```json block, or a bare top-level array.
const JSON_BLOCK = /```\s*json\s*\n([\s\S]*?)\s*```/i;
const BARE_ARRAY = /^\s*(\[[\s\S]*\])\s*$/;

export function parseVerdicts(rawText: string, refKey: 'thread_id' | 'check', allowed: Set<string>): Verdict[] {
  let body: string | null = null;
  const m = JSON_BLOCK.exec(rawText);
  if (m) body = m[1]!;
  else {
    const m2 = BARE_ARRAY.exec(rawText);
    if (m2) body = m2[1]!;
  }
  if (body === null) throw new Error('sage.critic_parse_error: triage output had no JSON block');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(`sage.critic_parse_error: triage JSON did not parse: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(parsed)) throw new Error('sage.critic_parse_error: triage JSON was not an array');

  const out: Verdict[] = [];
  parsed.forEach((row, i) => {
    if (!row || typeof row !== 'object') {
      console.warn(`[sage] triage row ${i} not an object; skipping`);
      return;
    }
    const r = row as Record<string, unknown>;
    const ref = String(r[refKey] ?? '').trim();
    if (!ref) {
      console.warn(`[sage] triage row ${i} missing ${refKey}; skipping`);
      return;
    }
    const verdict = String(r['verdict'] ?? '').trim().toLowerCase();
    if (!allowed.has(verdict)) {
      console.warn(`[sage] triage row ${i} has bad verdict ${verdict}; skipping`);
      return;
    }
    const fixHint = r['fix_hint'];
    out.push({
      ref,
      verdict,
      reason: String(r['reason'] ?? '').trim(),
      fixHint: fixHint ? String(fixHint).trim() : null,
    });
  });
  return out;
}
