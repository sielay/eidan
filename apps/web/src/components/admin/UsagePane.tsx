// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { Line, Bar } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from "chart.js";

import { useAuth } from "@/components/providers/auth-provider";
import {
  getUsageSummary,
  getUsageTimeSeries,
  getUsageModels,
  getUsageProviders,
  getUsageNodes,
  getRecentCalls,
  getUsageAgents,
  getUsageEfficiency,
  type UsageSummary,
  type TimeSeriesResponse,
  type ModelsResponse,
  type ProvidersResponse,
  type NodesResponse,
  type RecentCallsResponse,
  type AgentsUsageResponse,
  type EfficiencyResponse,
} from "@/lib/api/admin";
import { cn } from "@/lib/utils";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend
);

const METRIC_OPTIONS = ["cost", "input_tokens", "output_tokens", "cache_tokens"] as const;
type Metric = (typeof METRIC_OPTIONS)[number];

export function UsagePane(): React.ReactElement {
  const { user } = useAuth();
  const [startDate, setStartDate] = React.useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().split("T")[0];
  });
  const [endDate, setEndDate] = React.useState(() => new Date().toISOString().split("T")[0]);
  const [metric, setMetric] = React.useState<Metric>("cost");
  const [interval, setInterval] = React.useState<"day" | "week" | "month">("day");

  const [summary, setSummary] = React.useState<UsageSummary | null>(null);
  const [timeSeries, setTimeSeries] = React.useState<TimeSeriesResponse | null>(null);
  const [models, setModels] = React.useState<ModelsResponse | null>(null);
  const [providers, setProviders] = React.useState<ProvidersResponse | null>(null);
  const [nodes, setNodes] = React.useState<NodesResponse | null>(null);
  const [recentCalls, setRecentCalls] = React.useState<RecentCallsResponse | null>(null);
  const [agents, setAgents] = React.useState<AgentsUsageResponse | null>(null);
  const [efficiency, setEfficiency] = React.useState<EfficiencyResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const loadData = React.useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [s, ts, m, p, n, r, ag, ef] = await Promise.all([
        getUsageSummary({ start_date: startDate, end_date: endDate }),
        getUsageTimeSeries({
          start_date: startDate,
          end_date: endDate,
          interval,
          group_by: "provider",
        }),
        getUsageModels({ start_date: startDate, end_date: endDate, order_by: "cost" }),
        getUsageProviders({ start_date: startDate, end_date: endDate, order_by: "cost" }),
        getUsageNodes({ start_date: startDate, end_date: endDate, order_by: "cost" }),
        getRecentCalls({ limit: 50 }),
        getUsageAgents({ start_date: startDate, end_date: endDate }),
        getUsageEfficiency({ start_date: startDate, end_date: endDate }),
      ]);
      setSummary(s);
      setTimeSeries(ts);
      setModels(m);
      setProviders(p);
      setNodes(n);
      setRecentCalls(r);
      setAgents(ag);
      setEfficiency(ef);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [user, startDate, endDate, interval]);

  React.useEffect(() => {
    void loadData();
  }, [loadData]);

  const getMetricValue = (data: { cost_usd?: number; input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; cache_creation_tokens?: number }) => {
    switch (metric) {
      case "cost":
        return data.cost_usd ?? 0;
      case "input_tokens":
        return data.input_tokens ?? 0;
      case "output_tokens":
        return data.output_tokens ?? 0;
      case "cache_tokens":
        return (data.cache_read_tokens ?? 0) + (data.cache_creation_tokens ?? 0);
    }
  };

  const formatMetricValue = (value: number): string => {
    switch (metric) {
      case "cost":
        return `$${value.toFixed(2)}`;
      case "input_tokens":
      case "output_tokens":
      case "cache_tokens":
        return value.toLocaleString();
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 rounded-md border border-border bg-background p-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">Usage analytics over the selected date range</p>
          <button
            onClick={() => void loadData()}
            disabled={loading}
            className="text-xs px-2 py-1 rounded border border-border hover:bg-accent disabled:opacity-50"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Start Date</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="text-xs px-2 py-1 rounded border border-border"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">End Date</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="text-xs px-2 py-1 rounded border border-border"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Metric</label>
            <select
              value={metric}
              onChange={(e) => setMetric(e.target.value as Metric)}
              className="text-xs px-2 py-1 rounded border border-border"
            >
              {METRIC_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Interval</label>
            <select
              value={interval}
              onChange={(e) => setInterval(e.target.value as "day" | "week" | "month")}
              className="text-xs px-2 py-1 rounded border border-border"
            >
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
            </select>
          </div>
        </div>
      </div>

      {error && (
        <p className="rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      {summary && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <StatCard label="Total Cost" value={`$${summary.total_cost_usd.toFixed(2)}`} />
          <StatCard label="Input Tokens" value={summary.total_input_tokens.toLocaleString()} />
          <StatCard label="Output Tokens" value={summary.total_output_tokens.toLocaleString()} />
          <StatCard label="Cache Read" value={summary.total_cache_read_tokens.toLocaleString()} />
          <StatCard label="Cache Creation" value={summary.total_cache_creation_tokens.toLocaleString()} />
        </div>
      )}

      {timeSeries && (
        <section className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
          <h2 className="text-xs font-medium text-foreground">Usage Over Time</h2>
          <TimeSeriesChart data={timeSeries} metric={metric} formatValue={formatMetricValue} />
        </section>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {models && (
          <section className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
            <h2 className="text-xs font-medium text-foreground">Top Models by Cost</h2>
            <BreakdownTable
              items={models.models.slice(0, 10)}
              keyField="model"
              columns={["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "cost_usd", "call_count"]}
            />
          </section>
        )}
        {providers && (
          <section className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
            <h2 className="text-xs font-medium text-foreground">Providers</h2>
            <BreakdownTable
              items={providers.providers}
              keyField="provider"
              columns={["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "cost_usd", "call_count"]}
            />
          </section>
        )}
      </div>

      {efficiency && (
        <EfficiencyAdvisor data={efficiency} />
      )}

      {agents && agents.agents.length > 0 && (
        <section className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
          <h2 className="text-xs font-medium text-foreground">By Agent (runs &amp; cost)</h2>
          <div className="overflow-x-auto text-xs">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left p-2">Agent</th>
                  <th className="text-left p-2">Model</th>
                  <th className="text-right p-2">Runs</th>
                  <th className="text-right p-2">Tokens</th>
                  <th className="text-right p-2">Cost</th>
                  <th className="text-left p-2">Last run</th>
                </tr>
              </thead>
              <tbody>
                {agents.agents.map((a) => (
                  <tr key={a.agent_id} className="border-b border-border hover:bg-accent/20">
                    <td className="p-2 font-medium">{a.agent_name}</td>
                    <td className="p-2 text-muted-foreground">{a.model ?? "—"}</td>
                    <td className="p-2 text-right">{a.run_count.toLocaleString()}</td>
                    <td className="p-2 text-right">{a.total_tokens.toLocaleString()}</td>
                    <td className="p-2 text-right font-medium">${a.cost_usd.toFixed(4)}</td>
                    <td className="p-2 text-muted-foreground">
                      {a.last_run ? new Date(a.last_run).toLocaleString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {nodes && nodes.nodes.length > 0 && (
        <section className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
          <h2 className="text-xs font-medium text-foreground">Nodes</h2>
          <BreakdownTable
            items={nodes.nodes}
            keyField="node_id"
            columns={["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "cost_usd", "call_count"]}
          />
        </section>
      )}

      {recentCalls && recentCalls.calls.length > 0 && (
        <section className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
          <h2 className="text-xs font-medium text-foreground">Recent Calls ({recentCalls.total} total)</h2>
          <div className="overflow-x-auto text-xs">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left p-2">Time</th>
                  <th className="text-left p-2">Model</th>
                  <th className="text-left p-2">Role</th>
                  <th className="text-right p-2">Tokens</th>
                  <th className="text-right p-2">Cost</th>
                </tr>
              </thead>
              <tbody>
                {recentCalls.calls.slice(0, 20).map((call) => (
                  <tr key={call.id} className="border-b border-border hover:bg-accent/20">
                    <td className="p-2 text-muted-foreground">
                      {new Date(call.started_at).toLocaleString()}
                    </td>
                    <td className="p-2">{call.model}</td>
                    <td className="p-2">{call.role}</td>
                    <td className="p-2 text-right">
                      {(call.input_tokens + call.output_tokens + call.cache_read_tokens + call.cache_creation_tokens).toLocaleString()}
                    </td>
                    <td className="p-2 text-right font-medium">${call.cost_usd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

// Deterministic optimisation flags (the engine `observer` tool's efficiency_flags, user-scoped).
// No LLM — just surfaces where money is likely being wasted so the operator (or an advisor agent)
// knows where to look. An empty section renders a reassuring "no flags" line, not nothing.
function EfficiencyAdvisor({ data }: { data: EfficiencyResponse }): React.ReactElement {
  const empty =
    data.high_cost_agents.length === 0 &&
    data.logging_gaps.length === 0 &&
    data.cache_misses.length === 0;
  return (
    <section className="flex flex-col gap-3 rounded-md border border-border bg-background p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium text-foreground">Efficiency Advisor</h2>
        <span className="text-[10px] text-muted-foreground">deterministic — no LLM</span>
      </div>
      {empty && (
        <p className="text-xs text-muted-foreground">No efficiency flags for this range. 🎉</p>
      )}
      {data.high_cost_agents.length > 0 && (
        <FlagGroup title="Pricey model, light work">
          {data.high_cost_agents.map((f, i) => (
            <FlagRow
              key={`hc-${i}`}
              head={`${f.name} · ${f.model}`}
              meta={`${f.tokens.toLocaleString()} tok · $${f.cost_usd.toFixed(4)}`}
              reason={f.reason}
            />
          ))}
        </FlagGroup>
      )}
      {data.cache_misses.length > 0 && (
        <FlagGroup title="Low cache hit-rate">
          {data.cache_misses.map((f, i) => (
            <FlagRow
              key={`cm-${i}`}
              head={`${f.provider} · ${f.model}`}
              meta={`${f.tokens.toLocaleString()} tok · in:out ${f.input_output_ratio}`}
              reason={f.reason}
            />
          ))}
        </FlagGroup>
      )}
      {data.logging_gaps.length > 0 && (
        <FlagGroup title="Logging gaps">
          {data.logging_gaps.map((f, i) => (
            <FlagRow
              key={`lg-${i}`}
              head={f.agent}
              meta={`${f.run_count.toLocaleString()} runs`}
              reason={f.reason}
            />
          ))}
        </FlagGroup>
      )}
    </section>
  );
}

function FlagGroup({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

function FlagRow({ head, meta, reason }: { head: string; meta: string; reason: string }): React.ReactElement {
  return (
    <div className="rounded border border-amber-200 bg-amber-50 p-2 dark:border-amber-900 dark:bg-amber-950/30">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="text-xs font-medium text-foreground">{head}</span>
        <span className="text-[10px] text-muted-foreground">{meta}</span>
      </div>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{reason}</p>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-background/50 p-2">
      <p className="text-[10px] font-medium text-muted-foreground uppercase">{label}</p>
      <p className="text-sm font-bold text-foreground">{value}</p>
    </div>
  );
}

function TimeSeriesChart({
  data,
  metric,
  formatValue,
}: {
  data: TimeSeriesResponse;
  metric: Metric;
  formatValue: (v: number) => string;
}): React.ReactElement {
  const buckets = [...new Set(data.data.map((d) => d.bucket))].sort();
  const groups = [...new Set(data.data.map((d) => d.group))];

  const chartData = {
    labels: buckets,
    datasets: groups.map((group, idx) => {
      const values = buckets.map((bucket) => {
        const point = data.data.find((d) => d.bucket === bucket && d.group === group);
        if (!point) return 0;
        if (metric === "cost") return point.cost_usd;
        if (metric === "input_tokens") return point.input_tokens;
        if (metric === "output_tokens") return point.output_tokens;
        if (metric === "cache_tokens") return point.cache_read_tokens + point.cache_creation_tokens;
        return 0;
      });

      const colors = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6"];
      const color = colors[idx % colors.length];

      return {
        label: group,
        data: values,
        borderColor: color,
        backgroundColor: `${color}20`,
        borderWidth: 1,
        fill: true,
        tension: 0.4,
      };
    }),
  };

  return (
    <div className="h-64">
      <Line
        data={chartData}
        options={{
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              position: "bottom" as const,
              labels: { font: { size: 10 }, boxWidth: 10 },
            },
            tooltip: {
              callbacks: {
                label: (ctx) => `${ctx.dataset.label}: ${formatValue(ctx.parsed.y ?? 0)}`,
              },
            },
          },
          scales: {
            y: {
              ticks: { font: { size: 10 } },
            },
            x: {
              ticks: { font: { size: 10 } },
            },
          },
        }}
      />
    </div>
  );
}

// The cost/provider/node breakdown rows share these numeric columns; the dynamic label column is
// addressed by `keyField` (a real key of T), so the table stays type-safe without an index signature.
interface BreakdownBase {
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  call_count: number;
}
function BreakdownTable<T extends BreakdownBase>({
  items,
  keyField,
  columns,
}: {
  items: T[];
  keyField: Extract<keyof T, string>;
  columns: string[];
}): React.ReactElement {
  return (
    <div className="overflow-x-auto text-xs">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left p-2">{keyField}</th>
            <th className="text-right p-2">Input</th>
            <th className="text-right p-2">Output</th>
            <th className="text-right p-2">Cache R</th>
            <th className="text-right p-2">Cache C</th>
            <th className="text-right p-2">Cost</th>
            <th className="text-right p-2">Calls</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={String(item[keyField])} className="border-b border-border hover:bg-accent/20">
              <td className="p-2 font-medium">{String(item[keyField])}</td>
              <td className="p-2 text-right">{(item.input_tokens as number)?.toLocaleString() ?? "—"}</td>
              <td className="p-2 text-right">{(item.output_tokens as number)?.toLocaleString() ?? "—"}</td>
              <td className="p-2 text-right">{(item.cache_read_tokens as number)?.toLocaleString() ?? "—"}</td>
              <td className="p-2 text-right">{(item.cache_creation_tokens as number)?.toLocaleString() ?? "—"}</td>
              <td className="p-2 text-right font-medium">${(item.cost_usd as number)?.toFixed(4) ?? "—"}</td>
              <td className="p-2 text-right">{(item.call_count as number)?.toLocaleString() ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
