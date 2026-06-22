// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { authFetch } from "@/lib/auth";

// Non-secret view of a registered connection — the password is never returned by the API, so it's
// not in this shape and never echoed back into the form.
interface Connection {
  id: string;
  name: string;
  slug: string;
  driver: string;
  host: string;
  port: number;
  database: string;
  username: string;
  options: Record<string, unknown>;
}

const DRIVERS = ["postgres", "mongodb"] as const;
const DEFAULT_PORT: Record<string, string> = { postgres: "5432", mongodb: "27017" };

const EMPTY = {
  name: "",
  driver: "postgres",
  host: "",
  port: "5432",
  database: "",
  username: "",
  password: "",
  options: "",
};

interface TestState {
  busy: boolean;
  ok?: boolean;
  msg?: string;
}

export default function Connections(): React.ReactElement {
  const [connections, setConnections] = React.useState<Connection[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [form, setForm] = React.useState({ ...EMPTY });
  const [tests, setTests] = React.useState<Record<string, TestState>>({});

  const set = React.useCallback((key: keyof typeof EMPTY, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
  }, []);

  // Switching driver retargets the default port when the operator hasn't typed a custom one.
  const setDriver = React.useCallback((driver: string) => {
    setForm((f) => ({
      ...f,
      driver,
      port: f.port === "" || Object.values(DEFAULT_PORT).includes(f.port) ? (DEFAULT_PORT[driver] ?? f.port) : f.port,
    }));
  }, []);

  const load = React.useCallback(async () => {
    try {
      const r = await authFetch("/api/db/connections");
      if (!r.ok) throw new Error(`load failed (${r.status})`);
      const j = (await r.json()) as { connections: Connection[] };
      setConnections(j.connections);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load connections");
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const resetForm = React.useCallback(() => {
    setForm({ ...EMPTY });
    setEditingId(null);
  }, []);

  // Add (POST) or, when editing, update (PUT). On edit a blank password keeps the sealed one.
  const save = React.useCallback(async () => {
    if (!form.name.trim() || !form.host.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const payload = {
        ...(editingId ? { id: editingId } : {}),
        name: form.name.trim(),
        driver: form.driver,
        host: form.host.trim(),
        port: form.port.trim(),
        database: form.database.trim(),
        username: form.username.trim(),
        password: form.password,
        options: form.options.trim(),
      };
      const r = await authFetch("/api/db/connections", {
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
      setError(e instanceof Error ? e.message : "failed to save connection");
    } finally {
      setBusy(false);
    }
  }, [form, editingId, load, resetForm]);

  const edit = React.useCallback((c: Connection) => {
    setEditingId(c.id);
    setForm({
      name: c.name,
      driver: c.driver,
      port: String(c.port),
      host: c.host,
      database: c.database,
      username: c.username,
      password: "",
      options: c.options && Object.keys(c.options).length > 0 ? JSON.stringify(c.options) : "",
    });
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  // Engine-side test: resolves the sealed password from the vault and connects with the real driver
  // from the engine (where the agent's tools run), so a green result reflects the real path.
  const test = React.useCallback(async (id: string) => {
    setTests((t) => ({ ...t, [id]: { busy: true } }));
    try {
      const r = await authFetch("/api/db/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!r.ok && j.ok === undefined) throw new Error(j.error ?? `test failed (${r.status})`);
      setTests((t) => ({ ...t, [id]: { busy: false, ok: !!j.ok, msg: j.ok ? "connected" : (j.error ?? "failed") } }));
    } catch (e) {
      setTests((t) => ({ ...t, [id]: { busy: false, ok: false, msg: e instanceof Error ? e.message : "test failed" } }));
    }
  }, []);

  const remove = React.useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        const r = await authFetch(`/api/db/connections?id=${encodeURIComponent(id)}`, { method: "DELETE" });
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

  const canSave = !busy && form.name.trim() !== "" && form.host.trim() !== "";

  return (
    <div className="db">
      <header className="db__head">
        <h1>Databases</h1>
        <p>
          Give the agent read/write access to your databases. Each connection&rsquo;s password is
          sealed in your vault — never shown back or handed to a model. The connection details
          (driver, host, port, database, username) are stored so the agent can reach the right
          server. Postgres and MongoDB are supported.
        </p>
      </header>

      {error ? <div className="db__err">{error}</div> : null}

      <section className="db__add">
        <h2>{editingId ? "Edit connection" : "Add a connection"}</h2>
        <label>
          Name
          <input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Prod analytics" disabled={busy} />
        </label>

        <div className="db__grid">
          <label>
            Driver
            <select value={form.driver} onChange={(e) => setDriver(e.target.value)} disabled={busy}>
              {DRIVERS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label className="db__port">
            Port
            <input value={form.port} onChange={(e) => set("port", e.target.value)} inputMode="numeric" disabled={busy} />
          </label>
        </div>

        <label>
          Host
          <input value={form.host} onChange={(e) => set("host", e.target.value)} placeholder="db.example.com" disabled={busy} />
        </label>
        <label>
          Database
          <input value={form.database} onChange={(e) => set("database", e.target.value)} placeholder="app" disabled={busy} />
        </label>
        <label>
          Username
          <input value={form.username} onChange={(e) => set("username", e.target.value)} autoComplete="off" placeholder="readonly" disabled={busy} />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => set("password", e.target.value)}
            placeholder={editingId ? "leave blank to keep current password" : "leave blank for passwordless / trust auth"}
            disabled={busy}
          />
        </label>
        <label>
          Options (JSON, optional)
          <textarea
            value={form.options}
            onChange={(e) => set("options", e.target.value)}
            placeholder={'{ "ssl": true }  ·  Mongo: { "srv": true, "authSource": "admin" }'}
            rows={2}
            disabled={busy}
          />
        </label>

        <div className="db__actions">
          <button className="db__btn" onClick={() => void save()} disabled={!canSave}>
            {editingId ? "Save changes" : "Add connection"}
          </button>
          {editingId ? (
            <button type="button" className="db__btn db__btn--quiet" onClick={resetForm} disabled={busy}>
              Cancel
            </button>
          ) : null}
        </div>
      </section>

      <section className="db__list">
        {connections === null ? (
          <p className="db__muted">Loading…</p>
        ) : connections.length === 0 ? (
          <p className="db__muted">No connections yet — add one above.</p>
        ) : (
          connections.map((c) => {
            const t = tests[c.id];
            return (
              <div className="db__row" key={c.id}>
                <div className="db__row-top">
                  <strong>{c.name}</strong>
                  <span className="db__chip db__chip--driver">{c.driver}</span>
                  <span className="db__chip">password sealed</span>
                  <button className="db__btn db__btn--quiet" onClick={() => void test(c.id)} disabled={busy || t?.busy}>
                    {t?.busy ? "Testing…" : "Test"}
                  </button>
                  <button className="db__btn db__btn--quiet" onClick={() => edit(c)} disabled={busy}>
                    Edit
                  </button>
                  <button className="db__btn db__btn--quiet" onClick={() => void remove(c.id)} disabled={busy}>
                    Remove
                  </button>
                </div>
                <dl className="db__meta">
                  <div>
                    <dt>Target</dt>
                    <dd>
                      {c.username ? `${c.username} @ ` : ""}
                      {c.host}:{c.port}
                      {c.database ? `/${c.database}` : ""}
                    </dd>
                  </div>
                </dl>
                {t && !t.busy && t.ok !== undefined ? (
                  <div className={t.ok ? "db__test db__test--ok" : "db__test db__test--bad"}>
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
