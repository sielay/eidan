// SPDX-License-Identifier: AGPL-3.0-or-later
// USD per 1M tokens, matched by model-name substring so a single rate covers the dated Anthropic IDs
// (`claude-haiku-4-5-20251001`), the OpenRouter slugs (`anthropic/claude-haiku-4.5`), and the eidan
// provider aliases (`haiku`/`claude`) that all carry the same underlying model. matbot adapters don't
// price calls — they emit token counts — so eidan computes cost here, the one place every call is
// recorded (chat, agents, sage). Returns undefined for an unknown model; the caller keeps whatever
// cost the provider reported (usually 0). Approximate list prices — refine as needed.
interface Rate { input: number; output: number; cacheRead: number; cacheWrite: number }

const RATES: { match: RegExp; rate: Rate }[] = [
  { match: /opus/i,        rate: { input: 15,    output: 75,  cacheRead: 1.5,   cacheWrite: 18.75 } },
  { match: /sonnet/i,      rate: { input: 3,     output: 15,  cacheRead: 0.3,   cacheWrite: 3.75 } },
  { match: /haiku/i,       rate: { input: 1,     output: 5,   cacheRead: 0.1,   cacheWrite: 1.25 } },
  { match: /gpt-4o-mini/i, rate: { input: 0.15,  output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 } },
  { match: /gpt-4o/i,      rate: { input: 2.5,   output: 10,  cacheRead: 1.25,  cacheWrite: 2.5 } },
  { match: /deepseek/i,    rate: { input: 0.27,  output: 1.1, cacheRead: 0.07,  cacheWrite: 0.27 } },
];

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export function costForModel(model: string, t: TokenCounts): number | undefined {
  const found = RATES.find(r => r.match.test(model));
  if (!found) return undefined;
  const { rate } = found;
  return (
    t.inputTokens * rate.input +
    t.outputTokens * rate.output +
    (t.cacheReadTokens ?? 0) * rate.cacheRead +
    (t.cacheCreationTokens ?? 0) * rate.cacheWrite
  ) / 1_000_000;
}
