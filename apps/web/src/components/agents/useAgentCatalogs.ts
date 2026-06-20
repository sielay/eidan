// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { useAuth } from "@/components/providers/auth-provider";
import {
  listAdminNodes,
  listAgentTools,
  listOpenRouterModels,
  type OpenRouterModel,
  type ToolCatalogEntry,
} from "@/lib/api/admin";

// The reference data the agent forms need: the @-mention tool catalogue, the OpenRouter model list,
// and the node ids. All fetched once; each degrades gracefully (the form still works without them).
export function useAgentCatalogs(): { tools: ToolCatalogEntry[]; models: OpenRouterModel[]; nodes: string[] } {
  const { user } = useAuth();
  const [tools, setTools] = React.useState<ToolCatalogEntry[]>([]);
  const [models, setModels] = React.useState<OpenRouterModel[]>([]);
  const [nodes, setNodes] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (!user) return;
    void listAgentTools().then(setTools).catch(() => { /* @-picker degrades to none */ });
    void listOpenRouterModels().then(setModels).catch(() => { /* picker still works as free text */ });
    void listAdminNodes().then((rows) => setNodes(rows.map((n) => n.node_id))).catch(() => { /* nicety */ });
  }, [user]);

  return { tools, models, nodes };
}
