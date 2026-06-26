// SPDX-License-Identifier: AGPL-3.0-or-later
// Client API for usage analytics endpoints
export interface UsageSummary {
  start_date: string;
  end_date: string;
  group_by: string;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  by_group: Array<{
    [key: string]: string | number;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    call_count: number;
  }>;
}

export interface TimeseriesData {
  start_date: string;
  end_date: string;
  interval: string;
  group_by: string | null;
  data: Array<{
    ts: string;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    call_count: number;
    [key: string]: unknown;
  }>;
}

export interface ModelData {
  start_date: string;
  end_date: string;
  order_by: string;
  models: Array<{
    model: string;
    provider: string;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    call_count: number;
  }>;
}

export interface ProviderData {
  start_date: string;
  end_date: string;
  order_by: string;
  providers: Array<{
    provider: string;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    call_count: number;
  }>;
}

export interface NodeData {
  start_date: string;
  end_date: string;
  order_by: string;
  nodes: Array<{
    node: string;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    call_count: number;
  }>;
}

export interface RecentCall {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  request_id: string | null;
  agent_id: string | null;
  provider: string;
  model: string;
  role: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  latency_ms: number | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface RecentCallsData {
  limit: number;
  offset: number;
  total: number;
  filters: {
    provider: string | null;
    model: string | null;
    role: string | null;
    since: string | null;
  };
  calls: RecentCall[];
}

export async function getUsageSummary(
  startDate: string,
  endDate: string,
  groupBy: string = "model",
  provider?: string,
  model?: string,
): Promise<UsageSummary> {
  const params = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    group_by: groupBy,
  });
  if (provider) params.set("provider", provider);
  if (model) params.set("model", model);

  const resp = await fetch(`/api/usage/summary?${params}`);
  if (!resp.ok) throw new Error(`Failed to fetch usage summary: ${resp.statusText}`);
  return resp.json();
}

export async function getUsageTimeseries(
  startDate: string,
  endDate: string,
  interval: string = "day",
  groupBy?: string,
): Promise<TimeseriesData> {
  const params = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    interval,
  });
  if (groupBy) params.set("group_by", groupBy);

  const resp = await fetch(`/api/usage/timeseries?${params}`);
  if (!resp.ok) throw new Error(`Failed to fetch usage timeseries: ${resp.statusText}`);
  return resp.json();
}

export async function getUsageModels(
  startDate: string,
  endDate: string,
  orderBy: string = "cost",
  limit: number = 100,
): Promise<ModelData> {
  const params = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    order_by: orderBy,
    limit: String(limit),
  });

  const resp = await fetch(`/api/usage/models?${params}`);
  if (!resp.ok) throw new Error(`Failed to fetch model data: ${resp.statusText}`);
  return resp.json();
}

export async function getUsageProviders(
  startDate: string,
  endDate: string,
  orderBy: string = "cost",
  limit: number = 100,
): Promise<ProviderData> {
  const params = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    order_by: orderBy,
    limit: String(limit),
  });

  const resp = await fetch(`/api/usage/providers?${params}`);
  if (!resp.ok) throw new Error(`Failed to fetch provider data: ${resp.statusText}`);
  return resp.json();
}

export async function getUsageNodes(
  startDate: string,
  endDate: string,
  orderBy: string = "cost",
): Promise<NodeData> {
  const params = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    order_by: orderBy,
  });

  const resp = await fetch(`/api/usage/nodes?${params}`);
  if (!resp.ok) throw new Error(`Failed to fetch node data: ${resp.statusText}`);
  return resp.json();
}

export async function getRecentCalls(
  limit: number = 20,
  offset: number = 0,
  filters?: { provider?: string; model?: string; role?: string; since?: string },
): Promise<RecentCallsData> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (filters?.provider) params.set("provider", filters.provider);
  if (filters?.model) params.set("model", filters.model);
  if (filters?.role) params.set("role", filters.role);
  if (filters?.since) params.set("since", filters.since);

  const resp = await fetch(`/api/usage/recent-calls?${params}`);
  if (!resp.ok) throw new Error(`Failed to fetch recent calls: ${resp.statusText}`);
  return resp.json();
}
