// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";

import { useAuth } from "@/components/providers/auth-provider";
import {
  addAgentSchedule,
  deleteAgent,
  listAgents,
  removeAgentTrigger,
  runAgentNow,
  updateAgent,
  type AgentInfo,
  type AgentRunInfo,
  type AgentTrigger,
} from "@/lib/api/admin";
import { cn } from "@/lib/utils";
import { Avatar } from "@/plugins/_shared/Avatar";

const SCHEDULE_PLACEHOLDER = 'e.g. "08:00", "mon,fri 17:30", "every 5 minutes", "hourly"';

/**
 * Agents — user-defined agents (a persona + its own model provider) bound to
 * composable triggers (schedule | sensor | webhook). Epic sielay/eidan#346.
 *
 * This is the LIST screen: create + edit live on their own routes (`/agents/new`,
 * `/agents/[id]`) which use the rich persona editor (TipTap + @-mention tools) and
 * the schedule builder — so authoring is friendly and reviewable, not a raw textarea.
 */
export default function AgentsPage(): React.ReactElement {
  const { user } = useAuth();
  const [agents, setAgents] = React.useState<AgentInfo[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const reload = React.useCallback(() => {
    void listAgents()
      .then((data) => { setAgents(data); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  React.useEffect(() => {
    if (!user) return;
    reload();
    const id = setInterval(reload, 15_000);
    return () => clearInterval(id);
  }, [user, reload]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">Agents</h1>
          <p className="text-sm text-muted-foreground">
            Standing agents with their own persona and model provider. Give one a trigger and it runs
            on its own — on a schedule today (clock or interval); sensors and webhooks are coming.
          </p>
        </div>
        <Link
          href="/agents/new"
          className="shrink-0 rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90"
        >
          New agent
        </Link>
      </header>

      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{error}</p>
      ) : agents === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : agents.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-background p-3 text-sm text-muted-foreground">
          No agents yet. <Link href="/agents/new" className="text-foreground underline">Create one</Link> — e.g.
          a “Vercel log analyst” every morning, or a “Daily thinker” pinned to the node with free ollama.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {agents.map((a) => (
            <li key={a.id}>
              <AgentCard agent={a} onChange={reload} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The persona's first paragraph (collapsed preview) — first non-empty block, whitespace-flattened.
function firstParagraph(s: string | null | undefined): string {
  const blocks = String(s ?? "").split(/\n\s*\n/);
  return (blocks.find((b) => b.trim()) ?? "").trim().replace(/\s+/g, " ");
}

function AgentCard({
  agent, onChange,
}: { agent: AgentInfo; onChange: () => void }): React.ReactElement {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [scheduleInput, setScheduleInput] = React.useState("");
  const [modelInput, setModelInput] = React.useState("");
  // Collapsed by default: only the header row + the persona's first paragraph show; everything else
  // (full persona, triggers, schedule, runs) is revealed on expand.
  const [expanded, setExpanded] = React.useState(false);

  async function act(fn: () => Promise<void>): Promise<void> {
    setBusy(true);
    try { await fn(); onChange(); } catch { /* surfaced on reload */ } finally { setBusy(false); }
  }

  return (
    <article className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          title={expanded ? "Collapse" : "Expand"}
          className="w-4 font-mono text-xs text-muted-foreground hover:text-foreground"
        >
          {expanded ? "▾" : "▸"}
        </button>
        <Avatar kind="agent" seed={agent.metadata?.avatar?.seed ?? agent.id} style={agent.metadata?.avatar?.style ?? null} size={22} title={agent.name} />
        <button
          disabled={busy}
          onClick={() => void act(() => updateAgent(agent.id, { enabled: !agent.enabled }))}
          className={cn(
            "rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
            agent.enabled ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200" : "bg-muted text-muted-foreground",
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
          <span className="rounded bg-sky-100 px-1.5 py-0.5 font-mono text-[10px] text-sky-800 dark:bg-sky-900/50 dark:text-sky-200" title="Model">
            {agent.model}
          </span>
        ) : null}
        {agent.target_node ? (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[10px] text-amber-800 dark:bg-amber-900/50 dark:text-amber-200" title="Pinned to this node">
            @{agent.target_node}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <button
            disabled={busy}
            onClick={() => void act(async () => { const { conversation_id } = await runAgentNow(agent.id); router.push(`/c/${conversation_id}`); })}
            className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            title="Run now (test) — fires the agent and opens the conversation it produces"
          >
            {busy ? "running…" : "▶ run"}
          </button>
          <Link href={`/agents/${agent.id}`} className="font-mono text-[10px] text-muted-foreground hover:text-foreground">
            edit
          </Link>
          <button disabled={busy} onClick={() => void act(() => deleteAgent(agent.id))} className="font-mono text-[10px] text-muted-foreground hover:text-red-600 dark:hover:text-red-400">
            delete
          </button>
        </div>
      </div>

      {!expanded ? (
        <button
          onClick={() => setExpanded(true)}
          title="Expand"
          className="truncate text-left text-xs text-muted-foreground hover:text-foreground"
        >
          {firstParagraph(agent.persona) || "(no persona)"}
        </button>
      ) : (
        <>
          <p className="whitespace-pre-wrap text-xs text-muted-foreground">{agent.persona}</p>

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
            <input
              value={modelInput} onChange={(e) => setModelInput(e.target.value)}
              placeholder="model (optional)"
              className="w-40 rounded border border-border bg-background px-2 py-0.5 font-mono text-[11px]"
              title="Optional model override for this trigger (e.g., 'haiku', 'deepseek'); omit to use agent default"
            />
            <button
              disabled={busy || !scheduleInput.trim()}
              onClick={() => void act(async () => { await addAgentSchedule(agent.id, scheduleInput.trim(), modelInput.trim() || undefined); setScheduleInput(""); setModelInput(""); })}
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
        </>
      )}
    </article>
  );
}

function TriggerChip({
  agentId, trigger, onChange,
}: { agentId: string; trigger: AgentTrigger; onChange: () => void }): React.ReactElement {
  const label = trigger.type === "schedule" ? String(trigger.config["schedule"] ?? "schedule") : trigger.type;
  const model = trigger.config["model"] ? String(trigger.config["model"]) : null;
  return (
    <span className="inline-flex items-center gap-1 rounded bg-indigo-100 px-1.5 py-0.5 font-mono text-[10px] text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-200">
      {label}
      {model ? <span className="ml-1 rounded bg-indigo-700/20 px-1">🤖 {model}</span> : null}
      <button
        onClick={() => void removeAgentTrigger(agentId, trigger.id).then(onChange).catch(() => undefined)}
        className="text-indigo-500 hover:text-red-600 dark:text-indigo-300 dark:hover:text-red-400"
        title="Remove trigger"
      >
        ×
      </button>
    </span>
  );
}

const RUN_STATUS_CLASS: Record<string, string> = {
  delivered: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200",
  started: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200",
  failed: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200",
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
