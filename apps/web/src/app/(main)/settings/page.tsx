// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { useAuth } from "@/components/providers/auth-provider";
import { ConnectionsSection } from "@/components/settings/ConnectionsSection";
import { Button } from "@/components/ui/button";
import {
  fetchAgent,
  putAgentPersona,
  type AgentRow,
} from "@/lib/api/agent";

/**
 * Settings page — persona editor for the operator's default agent.
 *
 * The hardcoded baseline identity ("you are Eidan, not Claude / ChatGPT")
 * always renders first regardless of what's here; this textarea writes
 * ``user_overrides.system_prompt`` which layers on top. Saving an empty
 * value clears the override and falls back to ``code_defaults.system_prompt``
 * (currently empty for the default agent — meaning the baseline alone).
 *
 * Phase 1 surface: one textarea. Phase 2 will add a `display_name` /
 * `description` editor and a per-plugin sub-persona table once the
 * plugin-command dispatch layer (issue #26) lands.
 */
export default function SettingsPage(): React.ReactElement {
  const { config, user, loading: authLoading } = useAuth();

  const [agent, setAgent] = React.useState<AgentRow | null>(null);
  const [draft, setDraft] = React.useState<string>("");
  const [loading, setLoading] = React.useState<boolean>(true);
  const [saving, setSaving] = React.useState<boolean>(false);
  const [error, setError] = React.useState<string | null>(null);
  const [savedAt, setSavedAt] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!config || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const row = await fetchAgent();
        if (cancelled) return;
        setAgent(row);
        setDraft(row.persona ?? "");
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "failed to load agent");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config, user]);

  const dirty = (agent?.persona ?? "") !== draft;

  const onSave = React.useCallback(async () => {
    if (!config || saving) return;
    setSaving(true);
    setError(null);
    try {
      // The backend collapses whitespace-only input to ``null`` (clear),
      // but mirror the convention here so the dirty-state heuristic stays
      // honest after a save: ``"   "`` shouldn't read as "still dirty".
      const trimmed = draft.trim();
      const persona = trimmed === "" ? null : trimmed;
      const row = await putAgentPersona(persona);
      setAgent(row);
      setDraft(row.persona ?? "");
      setSavedAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to save persona");
    } finally {
      setSaving(false);
    }
  }, [config, draft, saving]);

  const onRevert = React.useCallback(() => {
    setDraft(agent?.persona ?? "");
    setError(null);
  }, [agent]);

  if (authLoading) {
    return (
      <div className="p-6 text-sm text-muted-foreground">Loading…</div>
    );
  }
  if (!user) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Sign in to edit settings.
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-medium text-foreground">Agent persona</h1>
        <p className="text-xs text-muted-foreground">
          A short instruction Eidan reads at the start of every turn —
          tone, role, anything you want it to keep in mind. The baseline
          identity (&ldquo;you are Eidan, not Claude / ChatGPT&rdquo;) is always
          rendered first regardless; this layers on top.
        </p>
      </header>

      {error !== null ? (
        <div className="rounded-md border border-dashed border-border bg-background/60 p-3 text-xs text-red-600">
          {error}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <label
          htmlFor="persona-textarea"
          className="text-xs font-medium text-foreground"
        >
          user_overrides.system_prompt
        </label>
        <textarea
          id="persona-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={loading || saving}
          placeholder="e.g. You are concise and direct. No fluff, no apologies, no preamble."
          rows={10}
          className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm font-mono leading-relaxed text-foreground shadow-inner focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        />
        <p className="text-[11px] text-muted-foreground">
          Leave blank to clear the override. Whitespace-only input is
          treated as blank.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button
          onClick={onSave}
          disabled={!dirty || saving || loading}
          size="sm"
        >
          {saving ? "Saving…" : dirty ? "Save" : "Saved"}
        </Button>
        {dirty ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onRevert}
            disabled={saving}
          >
            Revert
          </Button>
        ) : null}
        {savedAt && !dirty ? (
          <span className="text-[11px] text-muted-foreground">
            Saved {new Date(savedAt).toLocaleTimeString()}
          </span>
        ) : null}
      </div>

      {agent ? (
        <section className="mt-6 flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-4 text-xs text-muted-foreground">
          <h2 className="font-medium text-foreground">Agent row</h2>
          <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1">
            <dt>display_name</dt>
            <dd className="text-foreground">{agent.display_name}</dd>
            <dt>agent_slug</dt>
            <dd className="font-mono">{agent.agent_slug}</dd>
            <dt>enabled</dt>
            <dd>{agent.enabled ? "yes" : "no"}</dd>
            <dt>description</dt>
            <dd>{agent.description ?? "—"}</dd>
            <dt>updated_at</dt>
            <dd className="font-mono">
              {new Date(agent.updated_at).toLocaleString()}
            </dd>
          </dl>
        </section>
      ) : null}

      <ConnectionsSection />
    </div>
  );
}
