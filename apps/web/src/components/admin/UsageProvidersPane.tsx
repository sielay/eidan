// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useEffect, useState } from "react";
import { getUsageProviders, type ProviderData } from "@/lib/api/usage";

const DEFAULT_DAYS = 30;

export function UsageProvidersPane(): React.ReactElement {
  const [data, setData] = useState<ProviderData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const now = new Date();
        const startDate = new Date(now.getTime() - DEFAULT_DAYS * 24 * 60 * 60 * 1000);

        const result = await getUsageProviders(
          startDate.toISOString(),
          now.toISOString(),
          "cost",
        );
        setData(result);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load provider data");
      } finally {
        setIsLoading(false);
      }
    }

    load();
  }, []);

  if (isLoading) return <div className="p-4 text-sm text-neutral-500">Loading provider data...</div>;
  if (error) return <div className="p-4 text-sm text-red-600">Error: {error}</div>;
  if (!data || data.providers.length === 0) return <div className="p-4 text-sm text-neutral-500">No provider data</div>;

  return (
    <div className="p-6 space-y-4">
      <h2 className="text-xl font-semibold">Provider Breakdown</h2>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {data.providers.map((p, idx) => (
          <div key={idx} className="border border-neutral-200 rounded-lg p-4 bg-white hover:bg-neutral-50">
            <div className="font-semibold text-lg mb-3">{p.provider}</div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-neutral-600">Cost:</span>
                <span className="font-semibold">${p.cost_usd.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-600">Calls:</span>
                <span>{p.call_count}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-600">Input Tokens:</span>
                <span>{p.input_tokens.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-600">Output Tokens:</span>
                <span>{p.output_tokens.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-600">Cache Tokens:</span>
                <span>{(p.cache_read_tokens + p.cache_creation_tokens).toLocaleString()}</span>
              </div>
              <div className="flex justify-between pt-2 border-t border-neutral-100">
                <span className="text-neutral-600">Avg Cost/Call:</span>
                <span>${(p.cost_usd / p.call_count).toFixed(4)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
