// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useEffect, useState } from "react";
import { getUsageSummary, getUsageTimeseries, type UsageSummary } from "@/lib/api/usage";

interface Stats {
  thisMonth: number;
  lastMonth: number;
  topModel: string;
  topCost: number;
}

export function UsageOverviewPane(): React.ReactElement {
  const [stats, setStats] = useState<Stats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const now = new Date();
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        const lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
        const lastMonthEnd = monthStart;
        const endOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));

        const thisMonthData = await getUsageSummary(
          monthStart.toISOString(),
          endOfMonth.toISOString(),
          "model",
        );

        const lastMonthData = await getUsageSummary(
          lastMonthStart.toISOString(),
          lastMonthEnd.toISOString(),
          "model",
        );

        const topGroup = thisMonthData.by_group?.[0];
        setStats({
          thisMonth: thisMonthData.total_cost_usd,
          lastMonth: lastMonthData.total_cost_usd,
          topModel: (topGroup?.model as string) || "N/A",
          topCost: (topGroup?.cost_usd as number) || 0,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load stats");
      } finally {
        setIsLoading(false);
      }
    }

    load();
  }, []);

  if (isLoading) return <div className="p-4 text-sm text-neutral-500">Loading usage overview...</div>;
  if (error) return <div className="p-4 text-sm text-red-600">Error: {error}</div>;
  if (!stats) return <div className="p-4 text-sm text-neutral-500">No usage data</div>;

  const trend = stats.lastMonth > 0 ? ((stats.thisMonth - stats.lastMonth) / stats.lastMonth * 100).toFixed(1) : 0;
  const trendDir = Number(trend) >= 0 ? "↑" : "↓";

  return (
    <div className="p-6 space-y-6">
      <h2 className="text-xl font-semibold">Usage Overview</h2>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* This Month */}
        <div className="border border-neutral-200 rounded-lg p-4 bg-white">
          <div className="text-xs font-medium text-neutral-600 uppercase tracking-wider mb-1">This Month</div>
          <div className="text-2xl font-bold">${stats.thisMonth.toFixed(2)}</div>
          <div className={`text-xs mt-2 ${Number(trend) >= 0 ? "text-red-600" : "text-green-600"}`}>
            {trendDir} {Math.abs(Number(trend)).toFixed(1)}% vs last month
          </div>
        </div>

        {/* Last Month */}
        <div className="border border-neutral-200 rounded-lg p-4 bg-white">
          <div className="text-xs font-medium text-neutral-600 uppercase tracking-wider mb-1">Last Month</div>
          <div className="text-2xl font-bold">${stats.lastMonth.toFixed(2)}</div>
        </div>

        {/* Top Model */}
        <div className="border border-neutral-200 rounded-lg p-4 bg-white">
          <div className="text-xs font-medium text-neutral-600 uppercase tracking-wider mb-1">Top Model</div>
          <div className="text-lg font-semibold truncate">{stats.topModel}</div>
          <div className="text-sm text-neutral-600 mt-2">${stats.topCost.toFixed(2)} this month</div>
        </div>

        {/* Summary */}
        <div className="border border-neutral-200 rounded-lg p-4 bg-white">
          <div className="text-xs font-medium text-neutral-600 uppercase tracking-wider mb-1">Status</div>
          <div className="text-sm text-neutral-700">
            <div>Usage tracked and ready to analyze</div>
          </div>
        </div>
      </div>
    </div>
  );
}
