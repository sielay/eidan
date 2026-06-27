// SPDX-License-Identifier: AGPL-3.0-or-later
// Centralized color scheme for the agent org chart

export const ORG_CHART_COLORS = {
  nodeStatus: {
    enabled: "#10b981",
    disabled: "#6b7280",
  },
  nodeProvider: {
    claude: "#9f7aea",
    openai: "#3b82f6",
    other: "#ec4899",
  },
  relationships: {
    reads_from: "#10b981",
    writes_to: "#f59e0b",
    asks: "#f97316",
    depends_on: "#ef4444",
    notifies: "#8b5cf6",
  },
} as const;
