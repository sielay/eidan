// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import * as React from "react";
import { useAuth } from "@/components/providers/auth-provider";
import { listAgents, type AgentInfo } from "@/lib/api/admin";
import { AgentForm } from "@/components/agents/AgentForm";
import { useAgentCatalogs } from "@/components/agents/useAgentCatalogs";

export default function EditAgentPage(): React.ReactElement {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { user } = useAuth();
  const { tools, models, nodes } = useAgentCatalogs();
  // undefined = loading, null = not found.
  const [agent, setAgent] = React.useState<AgentInfo | null | undefined>(undefined);

  React.useEffect(() => {
    if (!user) return;
    void listAgents()
      .then((list) => setAgent(list.find((a) => a.id === id) ?? null))
      .catch(() => setAgent(null));
  }, [user, id]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
      <Link href="/agents" className="text-sm text-muted-foreground hover:text-foreground">
        ← Agents
      </Link>
      {agent === undefined ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : agent === null ? (
        <p className="rounded-md border border-border bg-background p-3 text-sm text-muted-foreground">Agent not found.</p>
      ) : (
        <>
          <h1 className="text-xl font-semibold tracking-tight">Edit {agent.name}</h1>
          <AgentForm
            mode="edit"
            agentId={agent.id}
            initial={{
              name: agent.name,
              persona: agent.persona,
              provider: agent.provider ?? "",
              model: agent.model ?? "",
              target: agent.target_node ?? "",
            }}
            tools={tools}
            models={models}
            nodes={nodes}
          />
        </>
      )}
    </div>
  );
}
