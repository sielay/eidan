// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { secretRequired } from './vault.js';
import type { SpendAnalytics, ModelSpend, SpendTrend, ApiError } from './types.js';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const cache: Map<string, { data: SpendAnalytics; timestamp: number }> = new Map();

function getCacheKey(provider: string): string {
  return `spend_${provider}`;
}

function getFromCache(provider: string): SpendAnalytics | null {
  const key = getCacheKey(provider);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }
  cache.delete(key);
  return null;
}

function setInCache(provider: string, data: SpendAnalytics): void {
  cache.set(getCacheKey(provider), { data, timestamp: Date.now() });
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3
): Promise<Response> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '1', 10);
        await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter * 1000, 10000)));
        continue;
      }
      return res;
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
  throw new Error('Max retries exceeded');
}

function getDaysSince(daysAgo: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function dateToIso(d: Date): string {
  return d.toISOString().split('T')[0]!;
}

function buildEmptyTrends(daysBack: number = 30): SpendTrend[] {
  const trends: SpendTrend[] = [];
  for (let i = daysBack; i >= 0; i--) {
    const d = getDaysSince(i);
    trends.push({
      period: dateToIso(d),
      spend: 0,
    });
  }
  return trends;
}

// OpenRouter API client
export async function getOpenRouterSpend(ctx: ToolContext): Promise<{ data?: SpendAnalytics; error?: ApiError }> {
  try {
    const cached = getFromCache('openrouter');
    if (cached) return { data: cached };

    const apiKey = await secretRequired(ctx, 'OPENROUTER_API_KEY');

    const now = new Date();
    const start30d = getDaysSince(30);

    // OpenRouter /api/v1/usage/calls endpoint returns paginated usage data
    const usageRes = await fetchWithRetry('https://openrouter.ai/api/v1/usage/calls?limit=500', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!usageRes.ok) {
      return {
        error: {
          message: `OpenRouter API error: ${usageRes.status}. Please verify your API key is valid.`,
        },
      };
    }

    const usageData = (await usageRes.json()) as {
      data?: Array<{
        model: string;
        prompt_tokens: number;
        completion_tokens: number;
        total_cost: number;
        timestamp: string;
        cache_hit_ratio?: number;
      }>;
    };

    const modelMap = new Map<string, { spend: number; input: number; output: number; cache_ratio: number; count: number; promptTokens: number; completionTokens: number }>();
    const trendMap = new Map<string, number>();
    let totalSpend = 0;
    let totalInputCost = 0;
    let totalOutputCost = 0;
    let totalCacheRatio = 0;
    let callCount = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    if (usageData.data) {
      for (const call of usageData.data) {
        const callDate = new Date(call.timestamp);
        if (callDate < start30d || callDate > now) continue;

        const dateStr = dateToIso(callDate);
        const cost = call.total_cost;

        // Aggregate by model
        if (!modelMap.has(call.model)) {
          modelMap.set(call.model, { spend: 0, input: 0, output: 0, cache_ratio: 0, count: 0, promptTokens: 0, completionTokens: 0 });
        }
        const model = modelMap.get(call.model)!;
        model.spend += cost;
        model.promptTokens += call.prompt_tokens;
        model.completionTokens += call.completion_tokens;
        model.count += 1;
        if (call.cache_hit_ratio) {
          model.cache_ratio += call.cache_hit_ratio;
        }

        // Aggregate trend
        trendMap.set(dateStr, (trendMap.get(dateStr) ?? 0) + cost);

        // Totals
        totalSpend += cost;
        totalPromptTokens += call.prompt_tokens;
        totalCompletionTokens += call.completion_tokens;
        totalCacheRatio += call.cache_hit_ratio ?? 0;
        callCount += 1;
      }
    }

    // Estimate input/output cost split based on token ratio (OpenRouter API does not expose per-token-type pricing)
    const totalTokens = totalPromptTokens + totalCompletionTokens;
    if (totalTokens > 0) {
      totalInputCost = Math.round((totalSpend * (totalPromptTokens / totalTokens)) * 100) / 100;
      totalOutputCost = Math.round((totalSpend * (totalCompletionTokens / totalTokens)) * 100) / 100;
    }

    // Build model list with estimated input/output split
    const byModel: ModelSpend[] = Array.from(modelMap.entries())
      .map(([model, data]) => {
        const modelTokens = data.promptTokens + data.completionTokens;
        const modelInputCost = modelTokens > 0 ? Math.round((data.spend * (data.promptTokens / modelTokens)) * 100) / 100 : 0;
        const modelOutputCost = modelTokens > 0 ? Math.round((data.spend * (data.completionTokens / modelTokens)) * 100) / 100 : 0;

        const result: ModelSpend = {
          model,
          total_spend: Math.round(data.spend * 100) / 100,
          input_tokens_cost: modelInputCost,
          output_tokens_cost: modelOutputCost,
          currency: 'USD',
        };
        if (data.count > 0) {
          result.cache_hit_rate = Math.round((data.cache_ratio / data.count) * 100) / 100;
        }
        return result;
      })
      .sort((a, b) => b.total_spend - a.total_spend);

    // Build trend data
    const trends: SpendTrend[] = Array.from(trendMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([period, spend]) => ({
        period,
        spend: Math.round(spend * 100) / 100,
      }));

    if (trends.length === 0) {
      trends.push(...buildEmptyTrends(30));
    }

    const trend_7d = trends.filter((t) => {
      const d = new Date(t.period);
      return d > getDaysSince(7);
    });

    const data: SpendAnalytics = {
      provider: 'openrouter',
      total_spend_30d: Math.round(totalSpend * 100) / 100,
      currency: 'USD',
      total_input_cost: totalInputCost,
      total_output_cost: totalOutputCost,
      by_model: byModel,
      trend_7d,
      trend_30d: trends,
      cache_available: true,
    };
    if (callCount > 0) {
      data.cache_hit_rate = Math.round((totalCacheRatio / callCount) * 100) / 100;
    }

    setInCache('openrouter', data);
    return { data };
  } catch (err) {
    return {
      error: {
        message: err instanceof Error ? err.message : 'Unknown error fetching OpenRouter spend',
      },
    };
  }
}

// Anthropic API client
export async function getAnthropicSpend(ctx: ToolContext): Promise<{ data?: SpendAnalytics; error?: ApiError }> {
  try {
    const cached = getFromCache('anthropic');
    if (cached) return { data: cached };

    await secretRequired(ctx, 'ANTHROPIC_API_KEY');

    // Anthropic does not expose a public billing/usage history API. Per-call usage is available
    // via message response metadata, but aggregated historical spend is not exposed publicly.
    return {
      error: {
        message: 'Anthropic spend analytics unavailable: no public billing API. Check billing at https://console.anthropic.com/account/billing/overview',
      },
    };
  } catch (err) {
    return {
      error: {
        message: err instanceof Error ? err.message : 'Unknown error fetching Anthropic spend',
      },
    };
  }
}

// OpenAI API client
export async function getOpenAISpend(ctx: ToolContext): Promise<{ data?: SpendAnalytics; error?: ApiError }> {
  try {
    const cached = getFromCache('openai');
    if (cached) return { data: cached };

    const apiKey = await secretRequired(ctx, 'OPENAI_API_KEY');

    const now = new Date();
    const start30d = getDaysSince(30);
    const startDate = dateToIso(start30d);
    const endDate = dateToIso(now);

    // Query v1/dashboard/billing/usage for actual costs (requires org/project-level API key with billing read access)
    const billingRes = await fetchWithRetry(
      `https://api.openai.com/v1/dashboard/billing/usage?start_date=${startDate}&end_date=${endDate}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
      }
    );

    if (!billingRes.ok) {
      return {
        error: {
          message: 'OpenAI API error: Authentication failed or insufficient permissions. Please check your API key.',
        },
      };
    }

    // OpenAI's billing API does not expose per-token-type costs (input vs output separation not available)
    return {
      error: {
        message: 'OpenAI spend analytics unavailable: API does not expose input/output token cost separation. Total spend available via dashboard, not via API.',
      },
    };
  } catch (err) {
    return {
      error: {
        message: err instanceof Error ? err.message : 'Unknown error fetching OpenAI spend',
      },
    };
  }
}
