// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure tool-result truncation logic — no matbot dependency, so it unit-tests under plain `node --test`.

// A single tool result larger than this poisons the context window. Real incident: a GitHub
// `/pulls` API response fetched via the vendored `http` tool returned 333 KB (~83k tokens) in one
// call, pinning the conversation near the model's ceiling so every later turn degraded — one
// returned an empty completion and the turn was silently lost. We cap the result and TELL the model
// it was truncated, so it can re-query more narrowly instead of drowning. Tunable; 0 disables.
export const DEFAULT_MAX_CHARS = 50_000;

export function capFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['EIDAN_TOOL_RESULT_MAX_CHARS'];
  if (raw === undefined || raw === '') return DEFAULT_MAX_CHARS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_CHARS;
}

// The text the model will actually see (mirrors how the runner/AG-UI stringifies non-string tool
// results), so the cap measures real context cost. null = can't stringify -> leave untouched.
function asText(result: unknown): string | null {
  if (typeof result === 'string') return result;
  try { return JSON.stringify(result); } catch { return null; }
}

// Pure guard: return { result } to replace an oversized result with its capped head + a notice, or
// undefined to leave it as-is. The toolresult hook is a thin wrapper over this.
export function guardResult(result: unknown, max: number, toolName: string): { result: unknown } | undefined {
  if (max <= 0) return undefined;
  const text = asText(result);
  if (text === null || text.length <= max) return undefined;
  const omitted = text.length - max;
  const notice =
    `\n\n…[truncated by eidan tool-guard: the "${toolName}" result was ${text.length.toLocaleString()} chars; ` +
    `showing the first ${max.toLocaleString()}, ${omitted.toLocaleString()} omitted. ` +
    `Re-run with a narrower query (filter / fewer fields / pagination) to get the specific data you need.]`;
  return { result: text.slice(0, max) + notice };
}
