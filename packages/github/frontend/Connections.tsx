// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { authFetch } from "@/lib/auth";

export default function Connections(): React.ReactElement {
  const apiBase = "/api/github/accounts";
  const [accounts, setAccounts] = React.useState<
    Array<{
      id: string;
      name: string;
      slug: string;
      external_handle: string;
      status: string;
      token_expires_at: string | null;
      context?: string;
    }>
  >(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [name, setName] = React.useState("");
  const [pat, setPat] = React.useState("");
  const [tests, setTests] = React.useState<Record<string, { busy: boolean; ok?: boolean; msg?: string }>>({});
  const [editing, setEditing] = React.useState<string | null>(null);
  const [editName, setEditName] = React.useState("");
  const [editContext, setEditContext] = React.useState("");

  const load = React.useCallback(async () => {
    try {
      const r = await authFetch(apiBase);
      if (!r.ok) throw new Error(`load failed (${r.status})`);
      const j = (await r.json()) as { accounts: typeof accounts };
      setAccounts(j.accounts);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load accounts");
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    const onShow = (e: PageTransitionEvent): void => {
      if (e.persisted) setBusy(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  const canConnect = name.trim().length > 0 && pat.trim().length > 0;

  const connect = React.useCallback(async () => {
    if (!canConnect) return;
    setBusy(true);
    setError(null);
    try {
      const r = await authFetch(apiBase, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          pat: pat.trim(),
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!r.ok) throw new Error(j.error ?? `connect failed (${r.status})`);
      setName("");
      setPat("");
      await load();
      setBusy(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to start connection");
      setBusy(false);
    }
  }, [apiBase, canConnect, name, pat, load]);

  const test = React.useCallback(
    async (id: string) => {
      setTests((t) => ({ ...t, [id]: { busy: true } }));
      try {
        const r = await authFetch(apiBase, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ test: id }),
        });
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; handle?: string; error?: string };
        if (!r.ok && j.ok === undefined) throw new Error(j.error ?? `test failed (${r.status})`);
        setTests((t) => ({
          ...t,
          [id]: {
            busy: false,
            ok: !!j.ok,
            msg: j.ok ? (j.handle ? `connected as ${j.handle}` : "connected") : (j.error ?? "failed"),
          },
        }));
      } catch (e) {
        setTests((t) => ({ ...t, [id]: { busy: false, ok: false, msg: e instanceof Error ? e.message : "test failed" } }));
      }
    },
    [apiBase],
  );

  const startEdit = React.useCallback((a: typeof accounts[0]) => {
    setEditing(a.id);
    setEditName(a.name);
    setEditContext(a.context ?? "");
  }, []);

  const saveEdit = React.useCallback(async () => {
    if (!editing || !editName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await authFetch(apiBase, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ update: { id: editing, name: editName.trim(), context: editContext } }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!r.ok || !j.ok) throw new Error(j.error ?? `save failed (${r.status})`);
      setEditing(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to save");
    } finally {
      setBusy(false);
    }
  }, [apiBase, editing, editName, editContext, load]);

  const disconnect = React.useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        const r = await authFetch(`${apiBase}?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!r.ok) throw new Error(`disconnect failed (${r.status})`);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "failed to disconnect");
      } finally {
        setBusy(false);
      }
    },
    [apiBase, load],
  );

  return (
    <div className="sconn">
      <header className="sconn__head">
        <h1>GitHub</h1>
        <p>
          Connect one or more GitHub accounts so the agent can read repositories, files, issues, and pull requests.
          You provide a Personal Access Token (PAT); the token is sealed in your vault — never shown back or handed
          to a model.
        </p>
      </header>

      {error ? <div className="sconn__err">{error}</div> : null}

      <section className="sconn__add">
        <h2>Connect an account</h2>
        <div className="sconn__muted">
          Go to <strong>GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)</strong> (
          github.com/settings/tokens) and create a new token. Choose the scopes you need (e.g.{" "}
          <strong>repo</strong> for private repos, <strong>public_repo</strong> for public only). Copy the token and
          paste it below.
        </div>

        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Personal" disabled={busy} />
        </label>

        <label>
          Personal Access Token
          <input
            type="password"
            value={pat}
            onChange={(e) => setPat(e.target.value)}
            placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            autoComplete="off"
            disabled={busy}
          />
        </label>

        <button className="sconn__btn" onClick={() => void connect()} disabled={busy || !canConnect}>
          Connect
        </button>
      </section>

      <section className="sconn__list">
        {accounts === null ? (
          <p className="sconn__muted">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="sconn__muted">No accounts connected yet — add one above.</p>
        ) : (
          accounts.map((a) => {
            const t = tests[a.id];
            return (
              <div className="sconn__row" key={a.id}>
                <div className="sconn__row-top">
                  <strong>{a.name}</strong>
                  {a.external_handle ? (
                    <span className="sconn__handle">
                      {a.external_handle}
                    </span>
                  ) : null}
                  <span className={`sconn__chip sconn__chip--${a.status === "active" ? "connected" : "pending"}`}>
                    {a.status === "active" ? "connected" : "not connected"}
                  </span>
                  <button
                    className="sconn__btn sconn__btn--quiet"
                    onClick={() => void test(a.id)}
                    disabled={busy || t?.busy || a.status !== "active"}
                    title="Resolve the stored credential and call GitHub to confirm it works."
                  >
                    {t?.busy ? "Testing…" : "Test"}
                  </button>
                  <button className="sconn__btn sconn__btn--quiet" onClick={() => startEdit(a)} disabled={busy}>
                    Edit
                  </button>
                  <button className="sconn__btn sconn__btn--quiet" onClick={() => void disconnect(a.id)} disabled={busy}>
                    {a.status === "pending" ? "Remove" : "Disconnect"}
                  </button>
                </div>
                {editing === a.id ? (
                  <div className="sconn__edit">
                    <label>
                      Name
                      <input value={editName} onChange={(e) => setEditName(e.target.value)} disabled={busy} />
                    </label>
                    <label>
                      Context for the agent
                      <textarea
                        value={editContext}
                        onChange={(e) => setEditContext(e.target.value)}
                        rows={3}
                        placeholder="e.g. Main organization account — use for production repos."
                        disabled={busy}
                      />
                    </label>
                    <div className="sconn__row-top">
                      <button className="sconn__btn" onClick={() => void saveEdit()} disabled={busy || !editName.trim()}>
                        Save
                      </button>
                      <button className="sconn__btn sconn__btn--quiet" onClick={() => setEditing(null)} disabled={busy}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : a.context ? (
                  <p className="sconn__context">{a.context}</p>
                ) : null}
                {t && !t.busy && t.msg ? (
                  <p className={t.ok ? "sconn__test sconn__test--ok" : "sconn__test sconn__test--bad"}>
                    {t.ok ? "✓" : "✗"} {t.msg}
                  </p>
                ) : null}
                {a.status === "pending" ? (
                  <p className="sconn__muted">
                    Connection wasn't completed — re-enter the PAT above or remove it.
                  </p>
                ) : null}
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}
