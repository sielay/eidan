// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { authFetch } from "@/lib/auth";

// Non-secret view of a registered source — the API token is never returned, so it's not in this
// shape and never echoed back into the form.
interface Source {
  id: string;
  name: string;
  slug: string;
  provider: string;
  config: Record<string, unknown>;
}

const PROVIDERS = ["vercel", "fly", "heroku", "betterstack"] as const;

// Per-provider hint for the config JSON field — shows the operator which non-secret fields each
// provider expects. The token always goes in the separate (sealed) Token field.
const CONFIG_HINT: Record<string, string> = {
  vercel: '{ "project_id": "prj_…", "team_id": "team_… (optional)" }',
  fly: '{ "base_url": "https://your-fly-log-drain/…", "app": "my-app" }',
  heroku: '{ "app": "my-app", "source": "app (optional)", "dyno": "web.1 (optional)" }',
  betterstack: '{ "query_url": "https://…betterstackdata.com", "table": "t123_logs", "username": "team-id (optional)" }',
};

const EMPTY = { name: "", provider: "vercel", token: "", config: "" };

interface TestState {
  busy: boolean;
  ok?: boolean;
  msg?: string;
}

export default function Sources(): React.ReactElement {
  const [sources, setSources] = React.useState<Source[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [form, setForm] = React.useState({ ...EMPTY });
  const [tests, setTests] = React.useState<Record<string, TestState>>({});

  const set = React.useCallback((key: keyof typeof EMPTY, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
  }, []);

  const load = React.useCallback(async () => {
    try {
      const r = await authFetch("/api/logs/sources");
      if (!r.ok) throw new Error(`load failed (${r.status})`);
      const j = (await r.json()) as { sources: Source[] };
      setSources(j.sources);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load log sources");
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const resetForm = React.useCallback(() => {
    setForm({ ...EMPTY });
    setEditingId(null);
  }, []);

  // Add (POST) or, when editing, update (PUT). On edit a blank token keeps the sealed one.
  const save = React.useCallback(async () => {
    if (!form.name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const payload = {
        ...(editingId ? { id: editingId } : {}),
        name: form.name.trim(),
        provider: form.provider,
        token: form.token,
        config: form.config.trim(),
      };
      const r = await authFetch("/api/logs/sources", {
        method: editingId ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `save failed (${r.status})`);
      }
      resetForm();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to save source");
    } finally {
      setBusy(false);
    }
  }, [form, editingId, load, resetForm]);

  const edit = React.useCallback((s: Source) => {
    setEditingId(s.id);
    setForm({
      name: s.name,
      provider: s.provider,
      token: "",
      config: s.config && Object.keys(s.config).length > 0 ? JSON.stringify(s.config) : "",
    });
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  // Engine-side test: resolves the sealed token from the vault and does a 1-line fetch through the
  // provider from the engine (where the agent's tools run), so a green result reflects the real path.
  const test = React.useCallback(async (id: string) => {
    setTests((t) => ({ ...t, [id]: { busy: true } }));
    try {
      const r = await authFetch("/api/logs/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; count?: number };
      if (!r.ok && j.ok === undefined) throw new Error(j.error ?? `test failed (${r.status})`);
      setTests((t) => ({
        ...t,
        [id]: { busy: false, ok: !!j.ok, msg: j.ok ? `reachable (${j.count ?? 0} line${j.count === 1 ? "" : "s"})` : (j.error ?? "failed") },
      }));
    } catch (e) {
      setTests((t) => ({ ...t, [id]: { busy: false, ok: false, msg: e instanceof Error ? e.message : "test failed" } }));
    }
  }, []);

  const remove = React.useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        const r = await authFetch(`/api/logs/sources?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!r.ok) throw new Error(`remove failed (${r.status})`);
        if (editingId === id) resetForm();
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "failed to remove");
      } finally {
        setBusy(false);
      }
    },
    [load, editingId, resetForm],
  );

  const canSave = !busy && form.name.trim() !== "";

  const summarise = (c: Record<string, unknown>): string => {
    const keys = ["project_id", "project", "app", "query_url", "table", "base_url"];
    const parts = keys
      .filter((k) => typeof c[k] === "string" && (c[k] as string).length > 0)
      .map((k) => `${k}=${c[k] as string}`);
    return parts.join(" · ");
  };

  return (
    <div className="logs">
      <header className="logs__head">
        <h1>Log sources</h1>
        <p>
          Let the agent read your deployment and app logs. Each source&rsquo;s API token is sealed in
          your vault — never shown back or handed to a model. The provider and non-secret config
          (project, app, query endpoint) are stored so the agent can reach the right logs. Vercel,
          Fly, Heroku and Better Stack are supported.
        </p>
      </header>

      {error ? <div className="logs__err">{error}</div> : null}

      <section className="logs__add">
        <h2>{editingId ? "Edit source" : "Add a source"}</h2>
        <label>
          Name
          <input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Prod web" disabled={busy} />
        </label>
        <label>
          Provider
          <select value={form.provider} onChange={(e) => set("provider", e.target.value)} disabled={busy}>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label>
          API token
          <input
            type="password"
            autoComplete="new-password"
            value={form.token}
            onChange={(e) => set("token", e.target.value)}
            placeholder={editingId ? "leave blank to keep current token" : "sealed in your vault"}
            disabled={busy}
          />
        </label>
        <label>
          Config (JSON)
          <textarea
            value={form.config}
            onChange={(e) => set("config", e.target.value)}
            placeholder={CONFIG_HINT[form.provider] ?? "{ }"}
            rows={2}
            disabled={busy}
          />
        </label>

        <div className="logs__actions">
          <button className="logs__btn" onClick={() => void save()} disabled={!canSave}>
            {editingId ? "Save changes" : "Add source"}
          </button>
          {editingId ? (
            <button type="button" className="logs__btn logs__btn--quiet" onClick={resetForm} disabled={busy}>
              Cancel
            </button>
          ) : null}
        </div>
      </section>

      <section className="logs__list">
        {sources === null ? (
          <p className="logs__muted">Loading…</p>
        ) : sources.length === 0 ? (
          <p className="logs__muted">No log sources yet — add one above.</p>
        ) : (
          sources.map((s) => {
            const t = tests[s.id];
            return (
              <div className="logs__row" key={s.id}>
                <div className="logs__row-top">
                  <strong>{s.name}</strong>
                  <span className="logs__chip logs__chip--provider">{s.provider}</span>
                  <span className="logs__chip">token sealed</span>
                  <button className="logs__btn logs__btn--quiet" onClick={() => void test(s.id)} disabled={busy || t?.busy}>
                    {t?.busy ? "Testing…" : "Test"}
                  </button>
                  <button className="logs__btn logs__btn--quiet" onClick={() => edit(s)} disabled={busy}>
                    Edit
                  </button>
                  <button className="logs__btn logs__btn--quiet" onClick={() => void remove(s.id)} disabled={busy}>
                    Remove
                  </button>
                </div>
                {summarise(s.config) ? (
                  <dl className="logs__meta">
                    <div>
                      <dt>Config</dt>
                      <dd>{summarise(s.config)}</dd>
                    </div>
                  </dl>
                ) : null}
                {t && !t.busy && t.ok !== undefined ? (
                  <div className={t.ok ? "logs__test logs__test--ok" : "logs__test logs__test--bad"}>
                    {t.ok ? "✓ " : "✗ "}
                    {t.msg}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}
