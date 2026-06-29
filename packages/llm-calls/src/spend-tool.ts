// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool } from '@matatbread/matbot-plugin-api';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import type { ProviderSpendStore } from './spend-store.js';

const DESCRIPTION = [
  'Record an ACTUAL provider spend figure read off a billing/invoice email (the ground truth the',
  'vendor APIs can\'t give us). Upserts one row per (provider, billing period) — re-recording the same',
  'invoice overwrites, so it is safe to re-scan a mailbox. The observer tool reconciles these actuals',
  'against the eidan.llm_calls estimate to surface untracked spend.',
  '',
  "Input: { provider: 'anthropic'|'openrouter'|'openai'|…, period_start: 'YYYY-MM-DD',",
  "         period_end: 'YYYY-MM-DD', amount: number, currency?='USD', invoice_ref?, source? }",
  'Use the VENDOR name for `provider` (who billed you), not an internal model alias.',
].join('\n');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

export function recordProviderSpendTool(store: ProviderSpendStore): Tool {
  return {
    name: 'record_provider_spend',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      required: ['provider', 'period_start', 'period_end', 'amount'],
      additionalProperties: false,
      properties: {
        provider: { type: 'string', description: 'vendor that billed you: anthropic | openrouter | openai | …' },
        period_start: { type: 'string', description: 'billing period start, YYYY-MM-DD' },
        period_end: { type: 'string', description: 'billing period end, YYYY-MM-DD' },
        amount: { type: 'number', description: 'amount billed for the period' },
        currency: { type: 'string', description: "ISO currency, default 'USD'" },
        invoice_ref: { type: 'string', description: 'invoice / receipt id (for dedup + audit)' },
        source: { type: 'string', description: "provenance, e.g. 'email:<message_id>'" },
      },
    },
    executor: {
      async *execute(input) {
        const a = (input ?? {}) as Record<string, unknown>;
        const userId = tryCurrentPrincipal()?.id;
        if (!userId) { yield { type: 'error', message: 'no user context' }; return; }
        const provider = str(a['provider']).trim();
        const periodStart = str(a['period_start']).trim();
        const periodEnd = str(a['period_end']).trim();
        const amount = typeof a['amount'] === 'number' ? a['amount'] : Number(a['amount']);
        if (!provider) { yield { type: 'error', message: 'provider is required' }; return; }
        if (!ISO_DATE.test(periodStart) || !ISO_DATE.test(periodEnd)) {
          yield { type: 'error', message: 'period_start and period_end must be YYYY-MM-DD' }; return;
        }
        if (!Number.isFinite(amount) || amount < 0) { yield { type: 'error', message: 'amount must be a non-negative number' }; return; }
        try {
          const id = await store.upsert(userId, {
            provider, periodStart, periodEnd, amount,
            currency: a['currency'] !== undefined ? str(a['currency']) : 'USD',
            invoiceRef: a['invoice_ref'] !== undefined ? str(a['invoice_ref']) : null,
            source: a['source'] !== undefined ? str(a['source']) : null,
            raw: { provider, period_start: periodStart, period_end: periodEnd, amount },
          });
          yield { type: 'result', value: { recorded: true, id, provider, period_start: periodStart, period_end: periodEnd, amount } };
        } catch (e) {
          yield { type: 'error', message: `record_provider_spend failed: ${e instanceof Error ? e.message : String(e)}` };
        }
      },
    },
  };
}
