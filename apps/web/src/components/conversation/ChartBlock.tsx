// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { Chart } from "react-chartjs-2";
import { Chart as ChartJS, type ChartType, type ChartData, type ChartOptions } from "chart.js/auto";

// Renders a ```chart fenced block from chat markdown: the block body is a chart.js
// config `{ type, data, options? }`. Mirrors potem's ChartBlock so the agent can
// emit charts (e.g. glue analytics) inline. Invalid JSON falls back to the raw text.

// Restrained dark-ish defaults so charts read against the chat surface without
// each config having to re-specify theme. Per-config options win.
ChartJS.defaults.color = "rgba(148,163,184,0.9)";
ChartJS.defaults.borderColor = "rgba(148,163,184,0.15)";
ChartJS.defaults.font.family =
  "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

interface ChartConfig {
  type: ChartType;
  data: ChartData;
  options?: ChartOptions;
}

function parse(config: string): { cfg: ChartConfig } | { error: string } {
  try {
    const c = JSON.parse(config) as Partial<ChartConfig>;
    if (!c || typeof c !== "object" || !c.type || !c.data) {
      return { error: 'chart block needs { "type", "data" }' };
    }
    return { cfg: c as ChartConfig };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "invalid chart JSON" };
  }
}

export function ChartBlock({ config }: { config: string }): React.ReactElement {
  const parsed = React.useMemo(() => parse(config), [config]);

  if ("error" in parsed) {
    return (
      <pre className="my-2 overflow-x-auto rounded-md bg-muted p-3 text-xs">
        <span className="text-muted-foreground">chart: {parsed.error}</span>
        {"\n"}
        {config}
      </pre>
    );
  }

  const { type, data, options } = parsed.cfg;
  return (
    <div
      className="my-2 rounded-md border border-border bg-card p-3"
      style={{ height: 320 }}
    >
      <Chart
        type={type}
        data={data}
        options={{ responsive: true, maintainAspectRatio: false, ...(options ?? {}) }}
      />
    </div>
  );
}
