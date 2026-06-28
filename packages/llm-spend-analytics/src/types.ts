// SPDX-License-Identifier: AGPL-3.0-or-later

export interface ApiError {
  message: string;
  code?: string;
}

export interface ModelSpend {
  model: string;
  total_spend: number;
  input_tokens_cost: number;
  output_tokens_cost: number;
  currency: string;
  cache_hit_rate?: number; // percentage 0-100
}

export interface SpendTrend {
  period: string; // ISO date (YYYY-MM-DD)
  spend: number;
}

export interface SpendAnalytics {
  provider: string;
  total_spend_30d: number;
  currency: string;
  total_input_cost: number;
  total_output_cost: number;
  cache_hit_rate?: number; // percentage 0-100 if available
  by_model: ModelSpend[];
  trend_7d: SpendTrend[];
  trend_30d: SpendTrend[];
  cache_available: boolean;
}

// OpenRouter types
export interface OpenRouterCostData {
  total_cost: number;
  model_costs: { [model: string]: number };
  input_cost: number;
  output_cost: number;
  cache_hit_rate?: number;
}

// Anthropic types
export interface AnthropicMessageMetadata {
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  cost: {
    input: number;
    output: number;
  };
}

// OpenAI types
export interface OpenAICostData {
  model: string;
  input_tokens: number;
  output_tokens: number;
  input_cost: number;
  output_cost: number;
  total_cost: number;
}
