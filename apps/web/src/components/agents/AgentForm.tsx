// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { createAgent, updateAgent, type OpenRouterModel, type ToolCatalogEntry } from "@/lib/api/admin";
import { Avatar, AVATAR_STYLES } from "@/plugins/_shared/Avatar";
import { VendorModelPicker, NodeSelect } from "./ModelPicker";
import { PersonaEditor } from "./PersonaEditor";
import { ScheduleBuilder } from "./ScheduleBuilder";

export interface AgentFormInitial {
  name: string;
  persona: string;
  provider: string;
  model: string;
  target: string;
  avatar?: { seed?: string; style?: string };
}

// The create + edit form, shared by /agents/new and /agents/[id]. `initial` is fixed at first render
// (the edit page gates until the agent is loaded), so the fields are plain controlled state.
export function AgentForm({
  mode,
  agentId,
  initial,
  tools,
  models,
  nodes,
}: {
  mode: "create" | "edit";
  agentId?: string;
  initial?: AgentFormInitial;
  tools: ToolCatalogEntry[];
  models: OpenRouterModel[];
  nodes: string[];
}): React.ReactElement {
  const router = useRouter();
  const [name, setName] = React.useState(initial?.name ?? "");
  const [persona, setPersona] = React.useState(initial?.persona ?? "");
  const [provider, setProvider] = React.useState(initial?.provider ?? "");
  const [model, setModel] = React.useState(initial?.model ?? "");
  const [target, setTarget] = React.useState(initial?.target ?? "");
  const [schedule, setSchedule] = React.useState("");
  const [avatarSeed, setAvatarSeed] = React.useState<string>(() => initial?.avatar?.seed || agentId || Math.random().toString(36).slice(2, 10));
  const [avatarStyle, setAvatarStyle] = React.useState<string>(initial?.avatar?.style || "bottts");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  async function submit(): Promise<void> {
    if (!name.trim() || !persona.trim()) {
      setErr("name and persona are required");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      if (mode === "create") {
        await createAgent({
          name: name.trim(),
          persona: persona.trim(),
          ...(provider.trim() ? { provider: provider.trim() } : {}),
          ...(model.trim() ? { model: model.trim() } : {}),
          ...(target ? { target_node: target } : {}),
          ...(schedule.trim() ? { schedule: schedule.trim() } : {}),
          avatar: { seed: avatarSeed, style: avatarStyle },
        });
      } else if (agentId) {
        await updateAgent(agentId, {
          name: name.trim(),
          persona: persona.trim(),
          provider: provider.trim() || null,
          model: model.trim() || null,
          target_node: target || null,
          avatar: { seed: avatarSeed, style: avatarStyle },
        });
      }
      router.push("/agents");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="flex flex-col gap-3"
    >
      <div className="flex items-end gap-3">
        <div className="flex flex-col items-center gap-1">
          <Avatar kind="agent" seed={avatarSeed} style={avatarStyle} size={44} title="Avatar" />
          <button
            type="button"
            onClick={() => setAvatarSeed(Math.random().toString(36).slice(2, 10))}
            className="font-mono text-[10px] text-muted-foreground hover:text-foreground"
            title="Randomise avatar"
          >
            🎲 random
          </button>
        </div>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Vercel log analyst"
            className="rounded border border-border bg-background px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">Avatar style</span>
          <select
            value={avatarStyle}
            onChange={(e) => setAvatarStyle(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1 text-sm"
          >
            {AVATAR_STYLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-muted-foreground">Model &amp; node</span>
        <div className="flex flex-wrap gap-2">
          <VendorModelPicker models={models} provider={provider} model={model} onChange={(p, m) => { setProvider(p); setModel(m); }} />
          <NodeSelect value={target} onChange={setTarget} nodes={nodes} />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-medium text-muted-foreground">Persona</span>
        <PersonaEditor value={persona} onChange={setPersona} tools={tools} rows={6} />
        <p className="text-[11px] text-muted-foreground">
          What it should do each run — type <span className="font-mono">@</span> to reference a tool; click a
          tool chip to set its parameters.
        </p>
      </div>

      {mode === "create" ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">Run on a schedule (optional)</span>
          <ScheduleBuilder value={schedule} onChange={setSchedule} />
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy} className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50">
          {busy ? "Saving…" : mode === "create" ? "Create agent" : "Save changes"}
        </button>
        <button type="button" disabled={busy} onClick={() => router.push("/agents")} className="rounded border border-border px-3 py-1.5 text-sm hover:bg-muted">
          Cancel
        </button>
        {err ? <span className="text-xs text-red-600">{err}</span> : null}
      </div>
    </form>
  );
}
