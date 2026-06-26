// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useEffect, useState } from "react";
import { getUsageModels, type ModelData } from "@/lib/api/usage";

const DEFAULT_DAYS = 30;

export function UsageModelsPane(): React.ReactElement {
  const [data, setData] = useState<ModelData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [orderBy, setOrderBy] = useState("cost");

  useEffect(() => {
    async function load() {
      try {
        const now = new Date();
        const startDate = new Date(now.getTime() - DEFAULT_DAYS * 24 * 60 * 60 * 1000);

        const result = await getUsageModels(
          startDate.toISOString(),
          now.toISOString(),
          orderBy,
        );
        setData(result);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load model data");
      } finally {
        setIsLoading(false);
      }
    }

    load();
  }, [orderBy]);

  if (isLoading) return <div className="p-4 text-sm text-neutral-500">Loading model data...</div>;
  if (error) return <div className="p-4 text-sm text-red-600">Error: {error}</div>;
  if (!data || data.models.length === 0) return <div className="p-4 text-sm text-neutral-500">No model data</div>;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Model Breakdown</h2>
        <div className="flex gap-2">
          <button
            onClick={() => setOrderBy("cost")}
            className={`px-3 py-1 text-sm rounded ${orderBy === "cost" ? "bg-blue-100 text-blue-700" : "bg-neutral-100"}`}
          >
            By Cost
          </button>
          <button
            onClick={() => setOrderBy("count")}
            className={`px-3 py-1 text-sm rounded ${orderBy === "count" ? "bg-blue-100 text-blue-700" : "bg-neutral-100"}`}
          >
            By Count
          </button>
          <button
            onClick={() => setOrderBy("tokens")}
            className={`px-3 py-1 text-sm rounded ${orderBy === "tokens" ? "bg-blue-100 text-blue-700" : "bg-neutral-100"}`}
          >
            By Tokens
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-neutral-200 text-left">
              <th className="px-4 py-2 font-semibold text-neutral-700">Model</th>
              <th className="px-4 py-2 font-semibold text-neutral-700">Provider</th>
              <th className="px-4 py-2 font-semibold text-neutral-700 text-right">Cost</th>
              <th className="px-4 py-2 font-semibold text-neutral-700 text-right">Input Tokens</th>
              <th className="px-4 py-2 font-semibold text-neutral-700 text-right">Output Tokens</th>
              <th className="px-4 py-2 font-semibold text-neutral-700 text-right">Cache Tokens</th>
              <th className="px-4 py-2 font-semibold text-neutral-700 text-right">Calls</th>
            </tr>
          </thead>
          <tbody>
            {data.models.map((m, idx) => (
              <tr key={idx} className="border-b border-neutral-100 hover:bg-neutral-50">
                <td className="px-4 py-3 font-mono text-sm">{m.model}</td>
                <td className="px-4 py-3 text-sm text-neutral-600">{m.provider}</td>
                <td className="px-4 py-3 text-right font-semibold">${m.cost_usd.toFixed(2)}</td>
                <td className="px-4 py-3 text-right text-neutral-600">{m.input_tokens.toLocaleString()}</td>
                <td className="px-4 py-3 text-right text-neutral-600">{m.output_tokens.toLocaleString()}</td>
                <td className="px-4 py-3 text-right text-neutral-600">{(m.cache_read_tokens + m.cache_creation_tokens).toLocaleString()}</td>
                <td className="px-4 py-3 text-right text-neutral-600">{m.call_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
