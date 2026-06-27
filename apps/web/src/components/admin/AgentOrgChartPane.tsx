// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { listAgents, type AgentInfo } from "@/lib/api/admin";
import { listEscalations, type EscalationSummary, listAgentRelationships, type AgentRelationship } from "@/lib/api/escalations";
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
  id: string;
  from: string;
  to: string;
  escalations: number;
  relationship?: AgentRelationship;
}

interface QuadtreeNode {
  x: number;
  y: number;
  size: number;
  nodes: NodeData[];
  children: QuadtreeNode[] | null;
}

function buildQuadtree(
  nodes: NodeData[],
  x: number,
  y: number,
  size: number,
  depth: number = 0,
): QuadtreeNode {
  const qt: QuadtreeNode = { x, y, size, nodes: [], children: null };
  const maxPerNode = 4;
  const minSize = 20;
  const maxDepth = 8;

  const nodesInCell = nodes.filter(
    n => n.x >= x && n.x < x + size && n.y >= y && n.y < y + size
  );

  if (
    nodesInCell.length > maxPerNode &&
    size > minSize &&
    depth < maxDepth
  ) {
    const half = size / 2;
    qt.children = [
      buildQuadtree(nodesInCell, x, y, half, depth + 1),
      buildQuadtree(nodesInCell, x + half, y, half, depth + 1),
      buildQuadtree(nodesInCell, x, y + half, half, depth + 1),
      buildQuadtree(nodesInCell, x + half, y + half, half, depth + 1),
    ];
  } else {
    qt.nodes = nodesInCell;
  }

  return qt;
}

function repulsionFromQuadtree(node: NodeData, qt: QuadtreeNode, force: number): { fx: number; fy: number } {
  let fx = 0;
  let fy = 0;
  const minDist = 0.1;

  if (qt.children) {
    for (const child of qt.children) {
      const { fx: cfx, fy: cfy } = repulsionFromQuadtree(node, child, force);
      fx += cfx;
      fy += cfy;
    }
  } else {
    for (const other of qt.nodes) {
      if (other.id === node.id) continue;
      const dx = node.x - other.x || minDist;
      const dy = node.y - other.y || minDist;
      const dist = Math.sqrt(dx * dx + dy * dy) || minDist;
      const f = force / (dist * dist);
      fx += (dx / dist) * f;
      fy += (dy / dist) * f;
    }
  }

  return { fx, fy };
}

const COLORS = {
  enabled: "#10b981",
  disabled: "#6b7280",
  claude: "#9f7aea",
  openai: "#3b82f6",
  other: "#ec4899",
};

const RELATIONSHIP_COLORS: Record<string, string> = {
  reads_from: "#10b981",
  writes_to: "#f59e0b",
  asks: "#f97316",
  depends_on: "#ef4444",
  notifies: "#8b5cf6",
};

export function AgentOrgChartPane(): React.ReactElement {
  const { user } = useAuth();
  const [agents, setAgents] = React.useState<AgentInfo[] | null>(null);
  const [escalations, setEscalations] = React.useState<EscalationSummary[] | null>(null);
  const [relationships, setRelationships] = React.useState<AgentRelationship[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedNode, setSelectedNode] = React.useState<string | null>(null);
  const [nodes, setNodes] = React.useState<NodeData[]>([]);
  const [edges, setEdges] = React.useState<EdgeData[]>([]);
  const [viewBoxDim, setViewBoxDim] = React.useState({ w: 800, h: 500 });
  const svgRef = React.useRef<SVGSVGElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const simulationRef = React.useRef<{
    nodes: NodeData[];
    animating: boolean;
    iterations: number;
    velocityHistory: number[];
    rafId: number | null;
    lastNodeCount: number;
    renderVersion: number;
    bounds: { width: number; height: number; minX: number; maxX: number; minY: number; maxY: number };
  } | null>(null);

  // Load agents, escalations, and relationships
  React.useEffect(() => {
    if (!user) return;
    Promise.all([listAgents(), listEscalations({ limit: 1000 }), listAgentRelationships()])
      .then(([agentsData, escalationsData, relationshipsData]) => {
        setAgents(agentsData);
        setEscalations(escalationsData);
        setRelationships(relationshipsData);
        setError(null);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [user]);

  // Update viewBox based on container size
  React.useEffect(() => {
    const updateViewBox = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          // Maintain 16:10 ratio for viewBox, or fit to container aspect ratio
          const containerAspect = rect.width / rect.height;
          let w = 800;
          let h = 500;
          const targetAspect = 16 / 10;
          if (containerAspect > targetAspect) {
            w = Math.round(h * containerAspect);
          } else {
            h = Math.round(w / containerAspect);
          }
          setViewBoxDim({ w, h });
        }
      }
    };

    updateViewBox();
    const observer = new ResizeObserver(updateViewBox);
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => observer.disconnect();
  }, []);

  // Build graph when agents/escalations/relationships change
  React.useEffect(() => {
    if (!agents) return;
    const newNodes: NodeData[] = agents.map((a) => ({
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

    // Build a map of agent names to IDs; track duplicates to avoid silent data loss
    const agentNameToIds = new Map<string, string[]>();
    for (const a of agents) {
      const current = agentNameToIds.get(a.name) ?? [];
      agentNameToIds.set(a.name, [...current, a.id]);
    }
    const agentIds = new Set(agents.map((a) => a.id));
    // Check for duplicate names that would make relationships ambiguous
    const duplicateNames = Array.from(agentNameToIds.entries()).filter(([, ids]) => ids.length > 1);
    if (duplicateNames.length > 0) {
      console.warn("Agent names are not unique. Relationships for these agents will be skipped:", duplicateNames.map(([name]) => name));
    }

    const newEdges: EdgeData[] = [];
    const edgeMap = new Map<string, { escalations: number; relationship?: AgentRelationship }>();

    if (escalations) {
      for (const e of escalations) {
        if (e.from_agent && e.to_agent && agentIds.has(e.from_agent) && agentIds.has(e.to_agent)) {
          const key = `${e.from_agent}→${e.to_agent}`;
          const existing = edgeMap.get(key) ?? { escalations: 0 };
          edgeMap.set(key, { ...existing, escalations: existing.escalations + 1 });
        }
      }
    }

    if (relationships) {
      for (const rel of relationships) {
        const fromIds = agentNameToIds.get(rel.from_agent_name) ?? [];
        const toIds = agentNameToIds.get(rel.to_agent_name) ?? [];
        // Only process relationships where agent names are unambiguous (exactly one agent per name)
        // and both agents exist in the current set
        if (fromIds.length !== 1 || toIds.length !== 1) {
          if (fromIds.length === 0 || toIds.length === 0) {
            // Agent name doesn't exist; skip silently (agent may have been deleted)
            continue;
          }
          // Multiple agents with the same name; ambiguous relationship
          console.warn(`Skipping relationship from "${rel.from_agent_name}" to "${rel.to_agent_name}": ambiguous agent names`);
          continue;
        }
        const fromId = fromIds[0];
        const toId = toIds[0];
        const key = `${fromId}→${toId}`;
        const existing = edgeMap.get(key) ?? { escalations: 0 };
        edgeMap.set(key, { ...existing, relationship: rel });
      }
    }

    for (const [key, data] of edgeMap) {
      const [from, to] = key.split("→");
      // Create separate edges for escalations and relationships so both can coexist and be styled independently
      if (data.escalations > 0) {
        newEdges.push({ id: `${from}|${to}|esc`, from, to, escalations: data.escalations });
      }
      if (data.relationship) {
        newEdges.push({ id: `${from}|${to}|rel-${data.relationship.relationship_type}`, from, to, escalations: 0, relationship: data.relationship });
      }
    }

    setNodes(newNodes);
    setEdges(newEdges);
  }, [agents, escalations, relationships]);

  // Force-directed simulation
  React.useEffect(() => {
    if (!agents || agents.length === 0) return;

    // Calculate bounds from viewBox dimensions (responsive to container size)
    const bounds = {
      width: viewBoxDim.w,
      height: viewBoxDim.h,
      minX: viewBoxDim.w * 0.0375,
      maxX: viewBoxDim.w * 0.9625,
      minY: viewBoxDim.h * 0.06,
      maxY: viewBoxDim.h * 0.94,
    };

    const initialNodes = agents.map((a) => ({
      id: a.id,
      name: a.name,
      enabled: a.enabled,
      provider: a.provider,
      model: a.model,
      persona: a.persona,
      triggers: a.triggers.length,
      x: Math.random() * (bounds.maxX - bounds.minX) + bounds.minX,
      y: Math.random() * (bounds.maxY - bounds.minY) + bounds.minY,
      vx: 0,
      vy: 0,
    }));

    if (!simulationRef.current) {
      simulationRef.current = {
        nodes: initialNodes,
        animating: true,
        iterations: 0,
        velocityHistory: [],
        rafId: null,
        lastNodeCount: initialNodes.length,
        renderVersion: 0,
        bounds,
      };
    } else {
      const sim = simulationRef.current;
      const simNodeMap = new Map(sim.nodes.map((n) => [n.id, n]));
      const newNodeIds = new Set(initialNodes.map((n) => n.id));

      // Merge new data with existing nodes, preserving velocity
      for (const newNode of initialNodes) {
        const existing = simNodeMap.get(newNode.id);
        if (existing) {
          existing.name = newNode.name;
          existing.enabled = newNode.enabled;
          existing.provider = newNode.provider;
          existing.model = newNode.model;
          existing.persona = newNode.persona;
          existing.triggers = newNode.triggers;
        } else {
          sim.nodes.push(newNode);
        }
      }

      // Remove nodes no longer in data
      sim.nodes = sim.nodes.filter((n) => newNodeIds.has(n.id));

      // Reset simulation if structure changed
      if (sim.nodes.length !== sim.lastNodeCount) {
        sim.iterations = 0;
        sim.velocityHistory = [];
        sim.lastNodeCount = sim.nodes.length;
      }
      sim.animating = true;
      sim.bounds = bounds;
    }

    const sim = simulationRef.current;
    const maxIterations = 1000;
    const convergenceWindow = 15;
    let frameCount = 0;

    const animate = () => {
      let maxVelocity = 0;
      const iterationsPerFrame = 2;

      for (let iter = 0; iter < iterationsPerFrame && sim.iterations < maxIterations && sim.animating; iter++) {
        const forces = new Map<string, { fx: number; fy: number }>();

        // Initialize forces for all nodes
        for (const node of sim.nodes) {
          forces.set(node.id, { fx: 0, fy: 0 });
        }

        // Repulsion between nodes using quadtree
        // ponytail: quadtree size could be dynamic based on node bounds, but 1024 safely covers viewport
        const qt = buildQuadtree(sim.nodes, 0, 0, 1024);
        for (const node of sim.nodes) {
          const { fx, fy } = repulsionFromQuadtree(node, qt, 10000);
          const nodeForces = forces.get(node.id)!;
          nodeForces.fx += fx;
          nodeForces.fy += fy;
        }

        // Collision detection for very close nodes to prevent overlap
        for (let i = 0; i < sim.nodes.length; i++) {
          for (let j = i + 1; j < sim.nodes.length; j++) {
            const n1 = sim.nodes[i];
            const n2 = sim.nodes[j];
            const dx = n2.x - n1.x;
            const dy = n2.y - n1.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
            const minCollisionDist = 40; // 2x node radius
            if (dist < minCollisionDist) {
              const overlap = minCollisionDist - dist;
              const f = overlap * 5;
              const nodeForces1 = forces.get(n1.id)!;
              const nodeForces2 = forces.get(n2.id)!;
              nodeForces1.fx -= (dx / dist) * f;
              nodeForces1.fy -= (dy / dist) * f;
              nodeForces2.fx += (dx / dist) * f;
              nodeForces2.fy += (dy / dist) * f;
            }
          }
        }

        // Attraction along edges
        const nodeMap = new Map(sim.nodes.map(n => [n.id, n]));
        for (const edge of edges) {
          const from = nodeMap.get(edge.from);
          const to = nodeMap.get(edge.to);
          if (!from || !to) continue;

          const fromForces = forces.get(from.id)!;
          const toForces = forces.get(to.id)!;

          const dx = to.x - from.x;
          const dy = to.y - from.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
          const forceFromTo = dist * 0.3;
          fromForces.fx += (dx / dist) * forceFromTo;
          fromForces.fy += (dy / dist) * forceFromTo;

          const forceToFrom = dist * 0.1;
          toForces.fx -= (dx / dist) * forceToFrom;
          toForces.fy -= (dy / dist) * forceToFrom;
        }

        // Apply velocity and position updates
        for (const node of sim.nodes) {
          const nodeForces = forces.get(node.id)!;
          node.vx = (node.vx + nodeForces.fx * 0.01) * 0.95;
          node.vy = (node.vy + nodeForces.fy * 0.01) * 0.95;
          node.x += node.vx;
          node.y += node.vy;

          // Bounce off edges using bounds
          if (node.x < sim.bounds.minX) {
            node.x = sim.bounds.minX;
            node.vx = Math.abs(node.vx);
          }
          if (node.x > sim.bounds.maxX) {
            node.x = sim.bounds.maxX;
            node.vx = -Math.abs(node.vx);
          }
          if (node.y < sim.bounds.minY) {
            node.y = sim.bounds.minY;
            node.vy = Math.abs(node.vy);
          }
          if (node.y > sim.bounds.maxY) {
            node.y = sim.bounds.maxY;
            node.vy = -Math.abs(node.vy);
          }

          maxVelocity = Math.max(maxVelocity, Math.abs(node.vx) + Math.abs(node.vy));
        }
        sim.iterations++;
      }

      // Update render every 3 frames with new array ref (reuses node objects, avoids expensive spreading)
      if (frameCount % 3 === 0) {
        setNodes([...sim.nodes]);
      }
      frameCount++;

      // Check convergence
      sim.velocityHistory.push(maxVelocity);
      if (sim.velocityHistory.length > convergenceWindow) {
        sim.velocityHistory.shift();
        const recentVelocities = sim.velocityHistory.slice(-convergenceWindow);
        const velocityChange = Math.max(...recentVelocities) - Math.min(...recentVelocities);
        if (velocityChange < 0.01) {
          sim.animating = false;
          // Final render
          setNodes([...sim.nodes]);
        }
      }

      if (sim.animating && maxVelocity > 0.1 && sim.iterations < maxIterations) {
        sim.rafId = requestAnimationFrame(animate);
      }
    };

    sim.rafId = requestAnimationFrame(animate);

    return () => {
      sim.animating = false;
      if (sim.rafId !== null) {
        cancelAnimationFrame(sim.rafId);
      }
    };
  }, [agents, edges, viewBoxDim]);

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
            <span>{edges.length} paths</span>
            <span>·</span>
            <span>{edges.filter((e) => e.escalations > 0).length} escalations</span>
            <span>·</span>
            <span>{edges.filter((e) => e.relationship).length} relationships</span>
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
          <div className="text-muted-foreground/60">Provider: claude (purple) • openai (blue) • other (pink)</div>
          <div className="text-muted-foreground/60">Relationships: reads_from (green) • writes_to (amber) • asks (orange) • depends_on (red) • notifies (purple) — dashed lines</div>
        </div>
      </div>

      {error && (
        <p className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="flex gap-4" style={{ height: "600px" }}>
        {/* Canvas */}
        <div
          ref={containerRef}
          className="flex-1 overflow-hidden rounded-md border border-border bg-background"
        >
          <svg
            ref={svgRef}
            width="100%"
            height="100%"
            viewBox={`0 0 ${viewBoxDim.w} ${viewBoxDim.h}`}
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
                const isRelationship = !!edge.relationship;
                const strokeColor = edge.relationship
                  ? (RELATIONSHIP_COLORS[edge.relationship.relationship_type] || "#cbd5e1")
                  : "#cbd5e1";
                const strokeDasharray = isRelationship ? "4,2" : "none";
                const description = edge.relationship?.description;

                return (
                  <g key={edge.id} opacity={opacity}>
                    {/* Arrow */}
                    <defs>
                      <marker
                        id={`arrow-${edge.id}`}
                        markerWidth="10"
                        markerHeight="10"
                        refX="8"
                        refY="3"
                        orient="auto"
                        markerUnits="strokeWidth"
                      >
                        <path d="M0,0 L0,6 L9,3 z" fill={strokeColor} />
                      </marker>
                    </defs>
                    <line
                      x1={from.x}
                      y1={from.y}
                      x2={to.x}
                      y2={to.y}
                      stroke={strokeColor}
                      strokeWidth={isRelationship ? (edge.relationship?.strength ?? 3) / 2 : 1.5}
                      strokeDasharray={strokeDasharray}
                      markerEnd={`url(#arrow-${edge.id})`}
                    >
                      {description && <title>{description}</title>}
                    </line>
                    {/* Label background for readability */}
                    {edge.escalations > 0 && (
                      <>
                        <rect
                          x={(from.x + to.x) / 2 - 7}
                          y={(from.y + to.y) / 2 - 10}
                          width="14"
                          height="12"
                          fill="#fafafa"
                          rx="1.5"
                          stroke="#e5e7eb"
                          strokeWidth="0.5"
                          pointerEvents="none"
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
                      </>
                    )}
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
                  {selectedAgentData.triggers.map((t) => {
                    let label = t.type;
                    if (t.type === "schedule") {
                      label = String(t.config["schedule"] ?? "schedule");
                    } else if (t.type === "sensor") {
                      label = `Sensor: ${String(t.config["sensor_id"] ?? "sensor")}`;
                    } else if (t.type === "webhook") {
                      label = `Webhook: ${String(t.config["path"] ?? "webhook")}`;
                    }
                    return (
                      <div key={t.id} className="rounded bg-indigo-100 px-1.5 py-0.5 font-mono text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-200">
                        {label}
                      </div>
                    );
                  })}
                </div>
              )}

              <div>
                <p className="text-muted-foreground">Persona</p>
                <p className="whitespace-pre-wrap text-xs">{selected.persona.slice(0, 200)}</p>
              </div>

              <div>
                <p className="text-muted-foreground">Outgoing Escalations</p>
                {edges
                  .filter((e) => e.from === selected.id && e.escalations > 0)
                  .map((e) => {
                    const target = nodes.find((n) => n.id === e.to);
                    return (
                      <p key={e.to} className="font-mono">
                        → {target?.name} ({e.escalations})
                      </p>
                    );
                  })}
                {edges.filter((e) => e.from === selected.id && e.escalations > 0).length === 0 && (
                  <p className="text-muted-foreground">none</p>
                )}
              </div>

              <div>
                <p className="text-muted-foreground">Incoming Escalations</p>
                {edges
                  .filter((e) => e.to === selected.id && e.escalations > 0)
                  .map((e) => {
                    const source = nodes.find((n) => n.id === e.from);
                    return (
                      <p key={e.from} className="font-mono">
                        ← {source?.name} ({e.escalations})
                      </p>
                    );
                  })}
                {edges.filter((e) => e.to === selected.id && e.escalations > 0).length === 0 && (
                  <p className="text-muted-foreground">none</p>
                )}
              </div>

              <div>
                <p className="text-muted-foreground">Outgoing Relationships</p>
                {edges
                  .filter((e) => e.from === selected.id && e.relationship)
                  .map((e) => {
                    const target = nodes.find((n) => n.id === e.to);
                    return (
                      <div key={e.to} className="text-xs">
                        <p className="font-mono">
                          → {target?.name} <span className="text-muted-foreground">({e.relationship?.relationship_type})</span>
                        </p>
                        {e.relationship?.description && (
                          <p className="text-muted-foreground text-xs pl-2">{e.relationship.description}</p>
                        )}
                      </div>
                    );
                  })}
                {edges.filter((e) => e.from === selected.id && e.relationship).length === 0 && (
                  <p className="text-muted-foreground">none</p>
                )}
              </div>

              <div>
                <p className="text-muted-foreground">Incoming Relationships</p>
                {edges
                  .filter((e) => e.to === selected.id && e.relationship)
                  .map((e) => {
                    const source = nodes.find((n) => n.id === e.from);
                    return (
                      <div key={e.from} className="text-xs">
                        <p className="font-mono">
                          ← {source?.name} <span className="text-muted-foreground">({e.relationship?.relationship_type})</span>
                        </p>
                        {e.relationship?.description && (
                          <p className="text-muted-foreground text-xs pl-2">{e.relationship.description}</p>
                        )}
                      </div>
                    );
                  })}
                {edges.filter((e) => e.to === selected.id && e.relationship).length === 0 && (
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
