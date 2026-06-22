// SPDX-License-Identifier: AGPL-3.0-or-later
// Concern type + tolerant parser shared by the (future) pre-PR critic and the self-review. Port of
// critic.py's Concern + parse_concerns. Strict on shape (must be a JSON array), lenient on content
// (a bad row is dropped, not fatal). An empty array is a valid "I looked, found nothing" outcome.

export interface Concern {
  severity: 'error' | 'warning' | 'note';
  kind: string | null;
  file: string | null;
  line: number | null;
  message: string;
  suggestedFix: string | null;
}

const VALID_SEVERITIES = new Set(['error', 'warning', 'note']);
const JSON_BLOCK = /```\s*json\s*\n([\s\S]*?)\s*```/i;
const BARE_ARRAY = /^\s*(\[[\s\S]*\])\s*$/;

export function parseConcerns(rawText: string): Concern[] {
  let body: string | null = null;
  const m = JSON_BLOCK.exec(rawText);
  if (m) body = m[1]!;
  else {
    const m2 = BARE_ARRAY.exec(rawText);
    if (m2) body = m2[1]!;
  }
  if (body === null) throw new Error('sage.critic_parse_error: critic output had no JSON block');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(`sage.critic_parse_error: critic JSON did not parse: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(parsed)) throw new Error('sage.critic_parse_error: critic JSON was not an array');

  const out: Concern[] = [];
  parsed.forEach((row, i) => {
    if (!row || typeof row !== 'object') {
      console.warn(`[sage] critic row ${i} not an object; skipping`);
      return;
    }
    const r = row as Record<string, unknown>;
    const sev = String(r['severity'] ?? '').trim().toLowerCase();
    if (!VALID_SEVERITIES.has(sev)) {
      console.warn(`[sage] critic row ${i} has bad severity ${sev}; skipping`);
      return;
    }
    const message = String(r['message'] ?? '').trim();
    if (!message) {
      console.warn(`[sage] critic row ${i} has empty message; skipping`);
      return;
    }
    let line: number | null = null;
    if (r['line'] !== null && r['line'] !== undefined) {
      const n = Number.parseInt(String(r['line']), 10);
      line = Number.isFinite(n) ? n : null;
    }
    out.push({
      severity: sev as 'error' | 'warning' | 'note',
      kind: r['kind'] ? String(r['kind']).trim() : null,
      file: r['file'] ? String(r['file']).trim() : null,
      line,
      message,
      suggestedFix: r['suggested_fix'] ? String(r['suggested_fix']).trim() : null,
    });
  });
  return out;
}
