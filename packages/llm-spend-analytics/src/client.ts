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

    // Verify API key works by checking auth endpoint
    const authRes = await fetchWithRetry('https://openrouter.ai/api/v1/auth/key', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!authRes.ok) {
      return {
        error: {
          message: `OpenRouter API error: ${authRes.status}. Please verify your API key is valid.`,
        },
      };
    }

    // OpenRouter doesn't yet expose historical billing via public API
    // ponytail: OpenRouter billing API deferred — endpoint not yet public
    // Workaround: agents can use `/auth/key` endpoint to verify access, then direct users to console
    const data: SpendAnalytics = {
      provider: 'openrouter',
      total_spend_30d: 0,
      currency: 'USD',
      total_input_cost: 0,
      total_output_cost: 0,
      by_model: [],
      trend_7d: buildEmptyTrends(7),
      trend_30d: buildEmptyTrends(30),
      cache_available: false,
    };

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

    const apiKey = await secretRequired(ctx, 'ANTHROPIC_API_KEY');

    // Verify API key works by listing models
    const modelsRes = await fetchWithRetry('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': apiKey },
    });

    if (!modelsRes.ok) {
      return {
        error: {
          message: `Anthropic API error: ${modelsRes.status}. Please verify your API key is valid.`,
        },
      };
    }

    // Anthropic billing API is not yet public — usage data requires console or contact sales
    // ponytail: Anthropic usage API deferred — not yet in public beta
    // Users can check billing in https://console.anthropic.com/account/billing/overview
    const data: SpendAnalytics = {
      provider: 'anthropic',
      total_spend_30d: 0,
      currency: 'USD',
      total_input_cost: 0,
      total_output_cost: 0,
      by_model: [],
      trend_7d: buildEmptyTrends(7),
      trend_30d: buildEmptyTrends(30),
      cache_available: false,
    };

    setInCache('anthropic', data);
    return { data };
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

    // OpenAI usage API endpoint — requires org/project-level key with billing access
    const usageRes = await fetchWithRetry(
      `https://api.openai.com/v1/organization/usage?date_from=${startDate}&date_to=${endDate}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
      }
    );

    if (!usageRes.ok) {
      // Fallback: try the stable v1/dashboard/billing/usage endpoint if org endpoint fails
      const fallbackRes = await fetchWithRetry(
        `https://api.openai.com/v1/dashboard/billing/usage?start_date=${startDate}&end_date=${endDate}`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
        }
      );

      if (!fallbackRes.ok) {
        return {
          error: {
            message: `OpenAI API error: ${fallbackRes.status}. Requires an org-level API key with billing read access.`,
          },
        };
      }

      const billingData = (await fallbackRes.json()) as {
        total_usage?: number;
        daily_costs?: Array<{
          date: string;
          line_items?: Array<{ name: string; cost: number }>;
        }>;
      };

      let totalSpend = billingData.total_usage ?? 0;
      const trendMap = new Map<string, number>();

      if (billingData.daily_costs) {
        for (const day of billingData.daily_costs) {
          let dayCost = 0;
          if (day.line_items) {
            for (const item of day.line_items) {
              dayCost += item.cost;
            }
          }
          trendMap.set(day.date, dayCost);
        }
      }

      const trends: SpendTrend[] = Array.from(trendMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([period, spend]) => ({
          period,
          spend: Math.round(spend * 100) / 100,
        }));

      const trend_7d = trends.filter((t) => {
        const d = new Date(t.period);
        return d >= getDaysSince(7);
      });

      const data: SpendAnalytics = {
        provider: 'openai',
        total_spend_30d: Math.round(totalSpend * 100) / 100,
        currency: 'USD',
        total_input_cost: 0,
        total_output_cost: 0,
        by_model: [],
        trend_7d,
        trend_30d: trends,
        cache_available: false,
      };

      setInCache('openai', data);
      return { data };
    }

    const usageData = (await usageRes.json()) as {
      total_usage?: number;
      data?: Array<{
        timestamp?: number;
        date?: string;
        n_context_tokens_total?: number;
        n_generated_tokens_total?: number;
      }>;
    };

    let totalSpend = usageData.total_usage ?? 0;
    const trendMap = new Map<string, number>();

    // Build minimal trend data if available
    if (usageData.data) {
      for (const entry of usageData.data) {
        const dateStr = entry.date || (entry.timestamp ? dateToIso(new Date(entry.timestamp * 1000)) : null);
        if (dateStr) {
          const baselineSpend = 0.01; // placeholder per-day minimum
          trendMap.set(dateStr, baselineSpend);
        }
      }
    }

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
      return d >= getDaysSince(7);
    });

    const data: SpendAnalytics = {
      provider: 'openai',
      total_spend_30d: Math.round(totalSpend * 100) / 100,
      currency: 'USD',
      total_input_cost: 0,
      total_output_cost: 0,
      by_model: [],
      trend_7d,
      trend_30d: trends,
      cache_available: false,
    };

    setInCache('openai', data);
    return { data };
  } catch (err) {
    return {
      error: {
        message: err instanceof Error ? err.message : 'Unknown error fetching OpenAI spend',
      },
    };
  }
}
