// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { listAgents, type AgentInfo } from "@/lib/api/admin";
import { listEscalations, type EscalationSummary } from "@/lib/api/escalations";
import { useAuth } from "@/components/providers/auth-provider";
import { cn } from "@/lib/utils";

interface NodeData {
  id: string;
  name: string;
  enabled: boolean;
  provider: string | null;
  model: string | null;
  persona: string;
  triggers: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface EdgeData {
  from: string;
  to: string;
  escalations: number;
}

const COLORS = {
  enabled: "#10b981",
  disabled: "#6b7280",
  claude: "#9f7aea",
  openai: "#3b82f6",
  other: "#ec4899",
};

export function AgentOrgChartPane(): React.ReactElement {
  const { user } = useAuth();
  const [agents, setAgents] = React.useState<AgentInfo[] | null>(null);
  const [escalations, setEscalations] = React.useState<EscalationSummary[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedNode, setSelectedNode] = React.useState<string | null>(null);
  const [nodes, setNodes] = React.useState<NodeData[]>([]);
  const [edges, setEdges] = React.useState<EdgeData[]>([]);
  const svgRef = React.useRef<SVGSVGElement>(null);

  // Load agents and escalations
  React.useEffect(() => {
    if (!user) return;
    Promise.all([listAgents(), listEscalations({ limit: 1000 })])
      .then(([agentsData, escalationsData]) => {
        setAgents(agentsData);
        setEscalations(escalationsData);
        setError(null);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [user]);

  // Build graph when agents/escalations change
  React.useEffect(() => {
    if (!agents) return;
    const newNodes: NodeData[] = agents.map((a, i) => ({
      id: a.id,
      name: a.name,
      enabled: a.enabled,
      provider: a.provider,
      model: a.model,
      persona: a.persona,
      triggers: a.triggers.length,
      x: Math.random() * 600 + 100,
      y: Math.random() * 350 + 75,
      vx: 0,
      vy: 0,
    }));

    const agentIds = new Set(agents.map((a) => a.id));
    const newEdges: EdgeData[] = [];
    const edgeMap = new Map<string, number>();

    if (escalations) {
      for (const e of escalations) {
        if (e.from_agent && e.to_agent && agentIds.has(e.from_agent) && agentIds.has(e.to_agent)) {
          const key = `${e.from_agent}→${e.to_agent}`;
          edgeMap.set(key, (edgeMap.get(key) ?? 0) + 1);
        }
      }
    }

    for (const [key, count] of edgeMap) {
      const [from, to] = key.split("→");
      newEdges.push({ from, to, escalations: count });
    }

    setNodes(newNodes);
    setEdges(newEdges);
  }, [agents, escalations]);

  // Force-directed simulation
  React.useEffect(() => {
    if (nodes.length === 0) return;

    let animating = true;
    let iterations = 0;
    const maxIterations = 500;
    const nodesWorkingCopy = nodes.map((n) => ({ ...n }));

    const animate = () => {
      let maxVelocity = 0;

      // Apply forces
      for (let i = 0; i < nodesWorkingCopy.length; i++) {
        const node = nodesWorkingCopy[i];
        let fx = 0,
          fy = 0;

        // Repulsion between nodes
        for (let j = 0; j < nodesWorkingCopy.length; j++) {
          if (i === j) continue;
          const other = nodesWorkingCopy[j];
          const dx = node.x - other.x || 0.1;
          const dy = node.y - other.y || 0.1;
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
          const force = 10000 / (dist * dist);
          fx += (dx / dist) * force;
          fy += (dy / dist) * force;
        }

        // Attraction along edges
        for (const edge of edges) {
          if (edge.from === node.id) {
            const target = nodesWorkingCopy.find((n) => n.id === edge.to);
            if (target) {
              const dx = target.x - node.x;
              const dy = target.y - node.y;
              const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
              const force = dist * 0.3;
              fx += (dx / dist) * force;
              fy += (dy / dist) * force;
            }
          } else if (edge.to === node.id) {
            const source = nodesWorkingCopy.find((n) => n.id === edge.from);
            if (source) {
              const dx = source.x - node.x;
              const dy = source.y - node.y;
              const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
              const force = dist * 0.1;
              fx += (dx / dist) * force;
              fy += (dy / dist) * force;
            }
          }
        }

        // Damping + update velocity
        node.vx = (node.vx + fx * 0.01) * 0.95;
        node.vy = (node.vy + fy * 0.01) * 0.95;
        node.x += node.vx;
        node.y += node.vy;

        // Bounce off edges
        if (node.x < 30) { node.x = 30; node.vx = Math.abs(node.vx); }
        if (node.x > 770) { node.x = 770; node.vx = -Math.abs(node.vx); }
        if (node.y < 30) { node.y = 30; node.vy = Math.abs(node.vy); }
        if (node.y > 470) { node.y = 470; node.vy = -Math.abs(node.vy); }

        maxVelocity = Math.max(maxVelocity, Math.abs(node.vx) + Math.abs(node.vy));
      }

      setNodes([...nodesWorkingCopy]);
      iterations++;

      // Stop if converged or max iterations reached
      if (animating && maxVelocity > 0.1 && iterations < maxIterations) {
        setTimeout(animate, 16);
      }
    };

    animate();

    return () => {
      animating = false;
    };
  }, [edges]);

  const providerColor = (provider: string | null): string => {
    if (!provider) return COLORS.other;
    if (provider.includes("claude")) return COLORS.claude;
    if (provider.includes("openai") || provider.includes("gpt")) return COLORS.openai;
    return COLORS.other;
  };

  const selected = selectedNode ? nodes.find((n) => n.id === selectedNode) : null;
  const selectedAgentData = selectedNode ? agents?.find((a) => a.id === selectedNode) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Agent Network Topology</h2>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{agents?.length ?? 0} agents</span>
            <span>·</span>
            <span>{edges.length} escalation paths</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <div className="h-2 w-2 rounded-full" style={{ backgroundColor: COLORS.enabled }} />
            <span>Enabled</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="h-2 w-2 rounded-full" style={{ backgroundColor: COLORS.disabled }} />
            <span>Paused</span>
          </div>
          <div className="text-muted-foreground/60">Provider color: claude (purple) • openai (blue) • other (pink)</div>
        </div>
      </div>

      {error && (
        <p className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="flex gap-4" style={{ height: "600px" }}>
        {/* Canvas */}
        <div className="flex-1 overflow-hidden rounded-md border border-border bg-background">
          <svg
            ref={svgRef}
            width="100%"
            height="100%"
            viewBox="0 0 800 500"
            preserveAspectRatio="xMidYMid meet"
            style={{ background: "#fafafa" }}
          >
            {/* Edges */}
            <g>
              {edges.map((edge) => {
                const from = nodes.find((n) => n.id === edge.from);
                const to = nodes.find((n) => n.id === edge.to);
                if (!from || !to) return null;

                const isSelected = selectedNode === from.id || selectedNode === to.id;
                const opacity = !selectedNode || isSelected ? 1 : 0.2;

                return (
                  <g key={`${edge.from}→${edge.to}`} opacity={opacity}>
                    {/* Arrow */}
                    <defs>
                      <marker
                        id={`arrow-${edge.from}-${edge.to}`}
                        markerWidth="10"
                        markerHeight="10"
                        refX="8"
                        refY="3"
                        orient="auto"
                        markerUnits="strokeWidth"
                      >
                        <path d="M0,0 L0,6 L9,3 z" fill="#a0aec0" />
                      </marker>
                    </defs>
                    <line
                      x1={from.x}
                      y1={from.y}
                      x2={to.x}
                      y2={to.y}
                      stroke="#cbd5e1"
                      strokeWidth="1.5"
                      markerEnd={`url(#arrow-${edge.from}-${edge.to})`}
                    />
                    {/* Label */}
                    <text
                      x={(from.x + to.x) / 2}
                      y={(from.y + to.y) / 2 - 4}
                      textAnchor="middle"
                      fontSize="10"
                      fill="#666"
                      pointerEvents="none"
                    >
                      {edge.escalations}
                    </text>
                  </g>
                );
              })}
            </g>

            {/* Nodes */}
            <g>
              {nodes.map((node) => {
                const isSelected = selectedNode === node.id;
                const size = isSelected ? 28 : 20;
                const color = node.enabled
                  ? providerColor(node.provider)
                  : COLORS.disabled;

                return (
                  <g
                    key={node.id}
                    onClick={() => setSelectedNode(isSelected ? null : node.id)}
                    style={{ cursor: "pointer" }}
                  >
                    <circle
                      cx={node.x}
                      cy={node.y}
                      r={size}
                      fill={color}
                      opacity={isSelected ? 1 : 0.7}
                      stroke={isSelected ? "#000" : "none"}
                      strokeWidth={isSelected ? 2 : 0}
                    />
                    {node.triggers > 0 && (
                      <circle
                        cx={node.x}
                        cy={node.y}
                        r={size + 4}
                        fill="none"
                        stroke="#fbbf24"
                        strokeWidth="2"
                        strokeDasharray="4,2"
                      />
                    )}
                    <text
                      x={node.x}
                      y={node.y + 4}
                      textAnchor="middle"
                      fontSize="11"
                      fontWeight="bold"
                      fill="#fff"
                      pointerEvents="none"
                    >
                      {node.name.slice(0, 2).toUpperCase()}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
        </div>

        {/* Details Panel */}
        {selected && selectedAgentData ? (
          <div className="w-80 overflow-y-auto rounded-md border border-border bg-background p-3">
            <h3 className="mb-3 text-sm font-semibold">{selected.name}</h3>

            <div className="space-y-3 text-xs">
              <div>
                <p className="text-muted-foreground">Status</p>
                <p
                  className={cn(
                    "rounded px-1.5 py-0.5 font-mono",
                    selected.enabled
                      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {selected.enabled ? "enabled" : "paused"}
                </p>
              </div>

              <div>
                <p className="text-muted-foreground">Provider & Model</p>
                <p className="font-mono">
                  {selected.provider ?? "default"} {selected.model ? `/ ${selected.model}` : ""}
                </p>
              </div>

              {selected.triggers > 0 && (
                <div>
                  <p className="text-muted-foreground">Triggers</p>
                  {selectedAgentData.triggers.map((t) => (
                    <div key={t.id} className="rounded bg-indigo-100 px-1.5 py-0.5 font-mono text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-200">
                      {t.type === "schedule" ? String(t.config["schedule"] ?? "schedule") : t.type}
                    </div>
                  ))}
                </div>
              )}

              <div>
                <p className="text-muted-foreground">Persona</p>
                <p className="whitespace-pre-wrap text-xs">{selected.persona.slice(0, 200)}</p>
              </div>

              <div>
                <p className="text-muted-foreground">Outgoing Escalations</p>
                {edges
                  .filter((e) => e.from === selected.id)
                  .map((e) => {
                    const target = nodes.find((n) => n.id === e.to);
                    return (
                      <p key={e.to} className="font-mono">
                        → {target?.name} ({e.escalations})
                      </p>
                    );
                  })}
                {edges.filter((e) => e.from === selected.id).length === 0 && (
                  <p className="text-muted-foreground">none</p>
                )}
              </div>

              <div>
                <p className="text-muted-foreground">Incoming Escalations</p>
                {edges
                  .filter((e) => e.to === selected.id)
                  .map((e) => {
                    const source = nodes.find((n) => n.id === e.from);
                    return (
                      <p key={e.from} className="font-mono">
                        ← {source?.name} ({e.escalations})
                      </p>
                    );
                  })}
                {edges.filter((e) => e.to === selected.id).length === 0 && (
                  <p className="text-muted-foreground">none</p>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="w-80 rounded-md border border-dashed border-border bg-background p-3 text-center">
            <p className="text-xs text-muted-foreground">Click an agent to see details</p>
          </div>
        )}
      </div>
    </div>
  );
}
