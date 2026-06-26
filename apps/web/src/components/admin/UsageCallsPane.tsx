// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useEffect, useState } from "react";
import { getRecentCalls, type RecentCallsData } from "@/lib/api/usage";

export function UsageCallsPane(): React.ReactElement {
  const [data, setData] = useState<RecentCallsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    async function load() {
      try {
        const result = await getRecentCalls(50, offset);
        setData(result);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load calls");
      } finally {
        setIsLoading(false);
      }
    }

    load();
  }, [offset]);

  if (isLoading) return <div className="p-4 text-sm text-neutral-500">Loading recent calls...</div>;
  if (error) return <div className="p-4 text-sm text-red-600">Error: {error}</div>;
  if (!data || data.calls.length === 0) return <div className="p-4 text-sm text-neutral-500">No recent calls</div>;

  const hasMore = data.offset + data.calls.length < data.total;
  const hasPrev = data.offset > 0;

  return (
    <div className="p-6 space-y-4">
      <h2 className="text-xl font-semibold">Recent LLM Calls</h2>

      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="border-b border-neutral-200 text-left">
              <th className="px-3 py-2 font-semibold text-neutral-700">Time</th>
              <th className="px-3 py-2 font-semibold text-neutral-700">Model</th>
              <th className="px-3 py-2 font-semibold text-neutral-700">Role</th>
              <th className="px-3 py-2 font-semibold text-neutral-700 text-right">Tokens In</th>
              <th className="px-3 py-2 font-semibold text-neutral-700 text-right">Tokens Out</th>
              <th className="px-3 py-2 font-semibold text-neutral-700 text-right">Cache</th>
              <th className="px-3 py-2 font-semibold text-neutral-700 text-right">Cost</th>
              <th className="px-3 py-2 font-semibold text-neutral-700 text-right">Latency</th>
            </tr>
          </thead>
          <tbody>
            {data.calls.map((call, idx) => {
              const time = new Date(call.started_at);
              const timeStr = time.toLocaleTimeString();
              const cacheTotal = call.cache_read_tokens + call.cache_creation_tokens;
              return (
                <tr key={idx} className={`border-b border-neutral-100 hover:bg-neutral-50 ${call.error ? "bg-red-50" : ""}`}>
                  <td className="px-3 py-2 text-neutral-600">{timeStr}</td>
                  <td className="px-3 py-2 font-mono">{call.model}</td>
                  <td className="px-3 py-2 text-neutral-600">{call.role}</td>
                  <td className="px-3 py-2 text-right">{call.input_tokens.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right">{call.output_tokens.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right text-neutral-600">{cacheTotal > 0 ? cacheTotal.toLocaleString() : "-"}</td>
                  <td className="px-3 py-2 text-right font-semibold">${call.cost_usd.toFixed(4)}</td>
                  <td className="px-3 py-2 text-right text-neutral-600">{call.latency_ms ? `${call.latency_ms}ms` : "-"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm">
        <div className="text-neutral-600">
          Showing {data.offset + 1}-{data.offset + data.calls.length} of {data.total}
        </div>
        <div className="flex gap-2">
          <button
            disabled={!hasPrev}
            onClick={() => setOffset(Math.max(0, offset - 50))}
            className="px-3 py-1 rounded bg-neutral-100 disabled:opacity-50 hover:bg-neutral-200"
          >
            ← Prev
          </button>
          <button
            disabled={!hasMore}
            onClick={() => setOffset(offset + 50)}
            className="px-3 py-1 rounded bg-neutral-100 disabled:opacity-50 hover:bg-neutral-200"
          >
            Next →
          </button>
        </div>
      </div>
    </div>
  );
}
