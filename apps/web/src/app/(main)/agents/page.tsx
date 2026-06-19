// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import Link from "next/link";
import * as React from "react";

import { useAuth } from "@/components/providers/auth-provider";
import {
  addAgentSchedule,
  createAgent,
  deleteAgent,
  listAdminNodes,
  listAgents,
  listOpenRouterModels,
  removeAgentTrigger,
  updateAgent,
  type AgentInfo,
  type AgentRunInfo,
  type AgentTrigger,
  type OpenRouterModel,
} from "@/lib/api/admin";
import { cn } from "@/lib/utils";

const SCHEDULE_PLACEHOLDER = 'e.g. "08:00", "mon,fri 17:30", "every 5 minutes", "hourly"';

// Friendly labels for the OpenRouter vendor prefixes (a model id is "<vendor>/<model>").
const VENDOR_LABELS: Record<string, string> = {
  openai: "OpenAI", anthropic: "Anthropic", google: "Google", "meta-llama": "Meta · Llama",
  deepseek: "DeepSeek", qwen: "Qwen", mistralai: "Mistral", "x-ai": "xAI",
  cohere: "Cohere", perplexity: "Perplexity", microsoft: "Microsoft", nvidia: "NVIDIA",
};
function vendorLabel(v: string): string {
  return VENDOR_LABELS[v] ?? v.charAt(0).toUpperCase() + v.slice(1);
}

// $/M-tokens hint from OpenRouter's per-token prompt price string.
function priceHint(m: OpenRouterModel): string {
  const p = m.prompt == null ? NaN : Number(m.prompt);
  if (p === 0) return "free";
  if (Number.isNaN(p)) return "";
  const perM = p * 1_000_000;
  return `$${perM < 1 ? perM.toFixed(2) : perM.toFixed(1)}/M`;
}

// Two cascading selects: provider/family → that family's models. Stores (provider, model): a catalog
// vendor maps to the `openrouter` base + the full "<vendor>/<model>" slug; "ollama" → a local model;
// blank → the node default. The engine runs any chosen model via a per-turn synthesized profile.
function VendorModelPicker({ models, provider, model, onChange }: {
  models: OpenRouterModel[];
  provider: string;
  model: string;
  onChange: (provider: string, model: string) => void;
}): React.ReactElement {
  const vendor = provider === "ollama" ? "ollama" : model.includes("/") ? (model.split("/")[0] ?? "") : "";
  const vendors = React.useMemo(() => {
    const set = new Set<string>();
    for (const m of models) { const v = m.id.split("/")[0]; if (v) set.add(v); }
    return [...set].sort();
  }, [models]);
  const vendorModels = React.useMemo(
    () => models.filter((m) => m.id.startsWith(`${vendor}/`)).sort((a, b) => a.id.localeCompare(b.id)),
    [models, vendor],
  );
  return (
    <>
      <select
        value={vendor}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "ollama") onChange("ollama", "");
          else if (v === "") onChange("", "");
          else onChange("openrouter", ""); // family chosen — pick a model next
        }}
        className="min-w-[9rem] rounded border border-border bg-background px-2 py-1 text-sm"
        title="Provider / model family"
      >
        <option value="">node default</option>
        <option value="ollama">Ollama (local)</option>
        {vendors.map((v) => <option key={v} value={v}>{vendorLabel(v)}</option>)}
      </select>
      {vendor === "ollama" ? (
        <input
          value={model} onChange={(e) => onChange("ollama", e.target.value)}
          placeholder="local model (e.g. llama3.2:1b)"
          className="min-w-[12rem] flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-xs"
        />
      ) : vendor ? (
        <select
          value={model} onChange={(e) => onChange("openrouter", e.target.value)}
          className="min-w-[16rem] flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-xs"
        >
          <option value="">— pick a {vendorLabel(vendor)} model —</option>
          {vendorModels.map((m) => <option key={m.id} value={m.id}>{`${m.id.split("/").slice(1).join("/")} · ${priceHint(m)}`}</option>)}
          {model && !vendorModels.some((m) => m.id === model) ? <option value={model}>{model}</option> : null}
        </select>
      ) : (
        <span className="flex-1 self-center text-xs text-muted-foreground">uses the node default model</span>
      )}
    </>
  );
}

/**
 * Agents — user-defined agents (a persona + its own model provider) bound to
 * composable triggers (schedule | sensor | webhook). Epic sielay/eidan#346.
 * Slice 1 ships the schedule trigger (clock + interval). An agent can be pinned
 * to a node (target_node) when its provider only exists there (e.g. ollama on the
 * Pi). Every fire records an eidan.agent_runs row linking the conversation it ran.
 */
export default function AgentsPage(): React.ReactElement {
  const { user } = useAuth();
  const [agents, setAgents] = React.useState<AgentInfo[] | null>(null);
  const [nodes, setNodes] = React.useState<string[]>([]);
  const [models, setModels] = React.useState<OpenRouterModel[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  const reload = React.useCallback(() => {
    void listAgents()
      .then((data) => { setAgents(data); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    void listAdminNodes()
      .then((rows) => setNodes(rows.map((n) => n.node_id)))
      .catch(() => { /* node list is a nicety; ignore */ });
  }, []);

  React.useEffect(() => {
    if (!user) return;
    reload();
    const id = setInterval(reload, 15_000);
    return () => clearInterval(id);
  }, [user, reload]);

  // The OpenRouter catalog is large + cached server-side — fetch it once, not on the 15s reload.
  React.useEffect(() => {
    if (!user) return;
    void listOpenRouterModels().then(setModels).catch(() => { /* picker still works as free text */ });
  }, [user]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Agents</h1>
        <p className="text-sm text-muted-foreground">
          Standing agents with their own persona and model provider. Give one a trigger and it runs on
          its own — on a schedule today (clock or interval); sensors and webhooks are coming.
        </p>
      </header>

      <NewAgentForm models={models} nodes={nodes} onCreated={reload} />

      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>
      ) : agents === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : agents.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-background p-3 text-sm text-muted-foreground">
          No agents yet. Create one above — e.g. a “Vercel log analyst” every morning, or a “Daily
          thinker” pinned to the node with free ollama.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {agents.map((a) => (
            <li key={a.id}>
              <AgentCard agent={a} models={models} nodes={nodes} onChange={reload} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NodeSelect({
  value, onChange, nodes,
}: { value: string; onChange: (v: string) => void; nodes: string[] }): React.ReactElement {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="min-w-[10rem] rounded border border-border bg-background px-2 py-1 text-sm"
      title="Pin to a node (needed when the provider only exists on one node, e.g. ollama)"
    >
      <option value="">any node</option>
      {nodes.map((n) => <option key={n} value={n}>{n}</option>)}
      {value && !nodes.includes(value) ? <option value={value}>{value}</option> : null}
    </select>
  );
}

function NewAgentForm({ models, nodes, onCreated }: { models: OpenRouterModel[]; nodes: string[]; onCreated: () => void }): React.ReactElement {
  const [name, setName] = React.useState("");
  const [persona, setPersona] = React.useState("");
  const [provider, setProvider] = React.useState("");
  const [model, setModel] = React.useState("");
  const [target, setTarget] = React.useState("");
  const [schedule, setSchedule] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!name.trim() || !persona.trim()) { setErr("name and persona are required"); return; }
    setBusy(true);
    setErr(null);
    try {
      await createAgent({
        name: name.trim(),
        persona: persona.trim(),
        ...(provider.trim() ? { provider: provider.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(target ? { target_node: target } : {}),
        ...(schedule.trim() ? { schedule: schedule.trim() } : {}),
      });
      setName(""); setPersona(""); setProvider(""); setModel(""); setTarget(""); setSchedule("");
      onCreated();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
      <div className="text-sm font-medium">New agent</div>
      <div className="flex flex-wrap gap-2">
        <input
          value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. Vercel log analyst)"
          className="min-w-[12rem] flex-1 rounded border border-border bg-background px-2 py-1 text-sm"
        />
        <VendorModelPicker models={models} provider={provider} model={model} onChange={(p, m) => { setProvider(p); setModel(m); }} />
        <NodeSelect value={target} onChange={setTarget} nodes={nodes} />
      </div>
      <textarea
        value={persona} onChange={(e) => setPersona(e.target.value)} rows={2}
        placeholder="Persona — what it should do each run (e.g. “Summarise my unread Vercel mail and flag any errors”)"
        className="rounded border border-border bg-background px-2 py-1 text-sm"
      />
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder={`Schedule (optional) — ${SCHEDULE_PLACEHOLDER}`}
          className="min-w-[16rem] flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-xs"
        />
        <button
          type="submit" disabled={busy}
          className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create agent"}
        </button>
      </div>
      {err ? <p className="text-xs text-red-600">{err}</p> : null}
    </form>
  );
}

function AgentCard({
  agent, models, nodes, onChange,
}: { agent: AgentInfo; models: OpenRouterModel[]; nodes: string[]; onChange: () => void }): React.ReactElement {
  const [busy, setBusy] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [scheduleInput, setScheduleInput] = React.useState("");

  async function act(fn: () => Promise<void>): Promise<void> {
    setBusy(true);
    try { await fn(); onChange(); } catch { /* surfaced on reload */ } finally { setBusy(false); }
  }

  if (editing) {
    return <EditAgentForm agent={agent} models={models} nodes={nodes} onDone={() => { setEditing(false); onChange(); }} onCancel={() => setEditing(false)} />;
  }

  return (
    <article className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <button
          disabled={busy}
          onClick={() => void act(() => updateAgent(agent.id, { enabled: !agent.enabled }))}
          className={cn(
            "rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
            agent.enabled ? "bg-emerald-100 text-emerald-800" : "bg-muted text-muted-foreground",
          )}
          title="Toggle enabled"
        >
          {agent.enabled ? "on" : "paused"}
        </button>
        <span className="text-sm font-medium text-foreground">{agent.name}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {agent.provider ?? "default provider"}
        </span>
        {agent.model ? (
          <span className="rounded bg-sky-100 px-1.5 py-0.5 font-mono text-[10px] text-sky-800" title="Model">
            {agent.model}
          </span>
        ) : null}
        {agent.target_node ? (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[10px] text-amber-800" title="Pinned to this node">
            @{agent.target_node}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <button disabled={busy} onClick={() => setEditing(true)} className="font-mono text-[10px] text-muted-foreground hover:text-foreground">
            edit
          </button>
          <button disabled={busy} onClick={() => void act(() => deleteAgent(agent.id))} className="font-mono text-[10px] text-muted-foreground hover:text-red-600">
            delete
          </button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">{agent.persona}</p>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">triggers:</span>
        {agent.triggers.length === 0 ? (
          <span className="font-mono text-[10px] text-muted-foreground/60">none — add a schedule below</span>
        ) : (
          agent.triggers.map((t) => <TriggerChip key={t.id} agentId={agent.id} trigger={t} onChange={onChange} />)
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={scheduleInput} onChange={(e) => setScheduleInput(e.target.value)}
          placeholder={`add schedule — ${SCHEDULE_PLACEHOLDER}`}
          className="w-72 rounded border border-border bg-background px-2 py-0.5 font-mono text-[11px]"
        />
        <button
          disabled={busy || !scheduleInput.trim()}
          onClick={() => void act(async () => { await addAgentSchedule(agent.id, scheduleInput.trim()); setScheduleInput(""); })}
          className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-muted disabled:opacity-50"
        >
          + schedule
        </button>
      </div>

      {agent.recent_runs.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">runs:</span>
          {agent.recent_runs.map((r) => <RunChip key={r.fire_key} run={r} />)}
        </div>
      ) : null}
    </article>
  );
}

function EditAgentForm({
  agent, models, nodes, onDone, onCancel,
}: { agent: AgentInfo; models: OpenRouterModel[]; nodes: string[]; onDone: () => void; onCancel: () => void }): React.ReactElement {
  const [name, setName] = React.useState(agent.name);
  const [persona, setPersona] = React.useState(agent.persona);
  const [provider, setProvider] = React.useState(agent.provider ?? "");
  const [model, setModel] = React.useState(agent.model ?? "");
  const [target, setTarget] = React.useState(agent.target_node ?? "");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  async function save(): Promise<void> {
    if (!name.trim() || !persona.trim()) { setErr("name and persona are required"); return; }
    setBusy(true);
    setErr(null);
    try {
      await updateAgent(agent.id, {
        name: name.trim(),
        persona: persona.trim(),
        provider: provider.trim() || null,
        model: model.trim() || null,
        target_node: target || null,
      });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-foreground/30 bg-background p-3">
      <div className="text-sm font-medium">Edit agent</div>
      <div className="flex flex-wrap gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name"
          className="min-w-[12rem] flex-1 rounded border border-border bg-background px-2 py-1 text-sm" />
        <VendorModelPicker models={models} provider={provider} model={model} onChange={(p, m) => { setProvider(p); setModel(m); }} />
        <NodeSelect value={target} onChange={setTarget} nodes={nodes} />
      </div>
      <textarea value={persona} onChange={(e) => setPersona(e.target.value)} rows={3}
        className="rounded border border-border bg-background px-2 py-1 text-sm" />
      <div className="flex items-center gap-2">
        <button disabled={busy} onClick={() => void save()} className="rounded bg-foreground px-3 py-1 text-sm font-medium text-background disabled:opacity-50">
          {busy ? "Saving…" : "Save"}
        </button>
        <button disabled={busy} onClick={onCancel} className="rounded border border-border px-3 py-1 text-sm hover:bg-muted">
          Cancel
        </button>
        {err ? <span className="text-xs text-red-600">{err}</span> : null}
      </div>
    </div>
  );
}

function TriggerChip({
  agentId, trigger, onChange,
}: { agentId: string; trigger: AgentTrigger; onChange: () => void }): React.ReactElement {
  const label = trigger.type === "schedule" ? String(trigger.config["schedule"] ?? "schedule") : trigger.type;
  return (
    <span className="inline-flex items-center gap-1 rounded bg-indigo-100 px-1.5 py-0.5 font-mono text-[10px] text-indigo-800">
      {label}
      <button
        onClick={() => void removeAgentTrigger(agentId, trigger.id).then(onChange).catch(() => undefined)}
        className="text-indigo-500 hover:text-red-600"
        title="Remove trigger"
      >
        ×
      </button>
    </span>
  );
}

const RUN_STATUS_CLASS: Record<string, string> = {
  delivered: "bg-emerald-100 text-emerald-800",
  started: "bg-blue-100 text-blue-800",
  failed: "bg-red-100 text-red-800",
};

function RunChip({ run }: { run: AgentRunInfo }): React.ReactElement {
  const title = run.detail ? `${run.fire_key} · ${run.status} — ${run.detail}` : `${run.fire_key} · ${run.status}`;
  const chip = (
    <span
      className={cn("rounded px-1.5 py-0.5 font-mono text-[10px]", RUN_STATUS_CLASS[run.status] ?? "bg-muted text-muted-foreground")}
      title={title}
    >
      {run.fire_key}
    </span>
  );
  return run.conversation_id ? <Link href={`/c/${run.conversation_id}`}>{chip}</Link> : chip;
}
