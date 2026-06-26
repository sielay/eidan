// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useEffect, useState } from "react";
import { getUsageNodes, type NodeData } from "@/lib/api/usage";

const DEFAULT_DAYS = 30;

export function UsageNodesPane(): React.ReactElement {
  const [data, setData] = useState<NodeData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const now = new Date();
        const startDate = new Date(now.getTime() - DEFAULT_DAYS * 24 * 60 * 60 * 1000);

        const result = await getUsageNodes(
          startDate.toISOString(),
          now.toISOString(),
          "cost",
        );
        setData(result);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load node data");
      } finally {
        setIsLoading(false);
      }
    }

    load();
  }, []);

  if (isLoading) return <div className="p-4 text-sm text-neutral-500">Loading node data...</div>;
  if (error) return <div className="p-4 text-sm text-red-600">Error: {error}</div>;
  if (!data || data.nodes.length === 0) return <div className="p-4 text-sm text-neutral-500">No node data available</div>;

  const totalCost = data.nodes.reduce((sum, n) => sum + n.cost_usd, 0);

  return (
    <div className="p-6 space-y-4">
      <h2 className="text-xl font-semibold">Node Distribution</h2>

      <div className="space-y-3">
        {data.nodes.map((node, idx) => {
          const percentage = totalCost > 0 ? (node.cost_usd / totalCost) * 100 : 0;
          return (
            <div key={idx} className="border border-neutral-200 rounded-lg p-4 bg-white">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="font-semibold text-lg">{node.node}</div>
                  <div className="text-sm text-neutral-600">{node.call_count.toLocaleString()} calls</div>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-bold">${node.cost_usd.toFixed(2)}</div>
                  <div className="text-sm text-neutral-600">{percentage.toFixed(1)}% of total</div>
                </div>
              </div>

              <div className="w-full bg-neutral-200 rounded h-2 mb-3">
                <div className="bg-blue-500 rounded h-2" style={{ width: `${percentage}%` }} />
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-neutral-600">Input Tokens</div>
                  <div className="font-semibold">{node.input_tokens.toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-neutral-600">Output Tokens</div>
                  <div className="font-semibold">{node.output_tokens.toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-neutral-600">Cache Tokens</div>
                  <div className="font-semibold">{(node.cache_read_tokens + node.cache_creation_tokens).toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-neutral-600">Avg Cost/Call</div>
                  <div className="font-semibold">${(node.cost_usd / node.call_count).toFixed(4)}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
