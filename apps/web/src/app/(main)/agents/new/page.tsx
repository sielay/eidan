// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import Link from "next/link";
import * as React from "react";
import { AgentForm } from "@/components/agents/AgentForm";
import { useAgentCatalogs } from "@/components/agents/useAgentCatalogs";

export default function NewAgentPage(): React.ReactElement {
  const { tools, models, nodes } = useAgentCatalogs();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
      <Link href="/agents" className="text-sm text-muted-foreground hover:text-foreground">
        ← Agents
      </Link>
      <h1 className="text-xl font-semibold tracking-tight">New agent</h1>
      <AgentForm mode="create" tools={tools} models={models} nodes={nodes} />
    </div>
  );
}
