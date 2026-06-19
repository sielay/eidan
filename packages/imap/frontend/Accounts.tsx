// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { authFetch } from "@/lib/auth";

// Non-secret view of a registered account — passwords are never returned by the API, so they're not
// in this shape and never echoed back into the form.
interface Account {
  id: string;
  name: string;
  slug: string;
  imap_host: string;
  imap_port: number;
  imap_user: string;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_from: string;
}

const EMPTY = {
  name: "",
  imap_host: "",
  imap_port: "993",
  imap_user: "",
  imap_password: "",
  smtp_host: "",
  smtp_port: "587",
  smtp_user: "",
  smtp_password: "",
  smtp_from: "",
};

export default function Accounts(): React.ReactElement {
  const [accounts, setAccounts] = React.useState<Account[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [form, setForm] = React.useState({ ...EMPTY });
  // null = add mode; a string id = editing that account. In edit mode the password fields start blank
  // and mean "keep the current sealed secret" unless the operator types a new one.
  const [editingId, setEditingId] = React.useState<string | null>(null);

  const set = React.useCallback((key: keyof typeof EMPTY, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
  }, []);

  const resetForm = React.useCallback(() => {
    setForm({ ...EMPTY });
    setEditingId(null);
  }, []);

  const load = React.useCallback(async () => {
    try {
      const r = await authFetch("/api/imap/accounts");
      if (!r.ok) throw new Error(`load failed (${r.status})`);
      const j = (await r.json()) as { accounts: Account[] };
      setAccounts(j.accounts);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load mail accounts");
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Save the form — POST a new account, or PUT an edit when editingId is set. On edit, blank password
  // fields are omitted so the server keeps the existing sealed secret.
  const save = React.useCallback(async () => {
    if (!form.name.trim() || !form.imap_host.trim() || !form.imap_user.trim()) return;
    if (!editingId && !form.imap_password) return; // a new account must carry an IMAP password
    setBusy(true);
    setError(null);
    try {
      const r = await authFetch(
        editingId ? `/api/imap/accounts?id=${encodeURIComponent(editingId)}` : "/api/imap/accounts",
        {
          method: editingId ? "PUT" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: form.name.trim(),
            imap_host: form.imap_host.trim(),
            imap_port: form.imap_port.trim(),
            imap_user: form.imap_user.trim(),
            imap_password: form.imap_password,
            smtp_host: form.smtp_host.trim(),
            smtp_port: form.smtp_port.trim(),
            smtp_user: form.smtp_user.trim(),
            smtp_password: form.smtp_password,
            smtp_from: form.smtp_from.trim(),
          }),
        },
      );
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `save failed (${r.status})`);
      }
      resetForm();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to save account");
    } finally {
      setBusy(false);
    }
  }, [form, editingId, load, resetForm]);

  // Load an account's non-secret fields into the form for editing. Passwords are never returned by the
  // API, so they stay blank (placeholder tells the operator blank means "keep current").
  const edit = React.useCallback((a: Account) => {
    setEditingId(a.id);
    setError(null);
    setForm({
      name: a.name,
      imap_host: a.imap_host,
      imap_port: String(a.imap_port),
      imap_user: a.imap_user,
      imap_password: "",
      smtp_host: a.smtp_host,
      smtp_port: String(a.smtp_port),
      smtp_user: a.smtp_user,
      smtp_password: "",
      smtp_from: a.smtp_from,
    });
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const remove = React.useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        const r = await authFetch(`/api/imap/accounts?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!r.ok) throw new Error(`remove failed (${r.status})`);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "failed to remove");
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const canSave =
    !busy &&
    form.name.trim() !== "" &&
    form.imap_host.trim() !== "" &&
    form.imap_user.trim() !== "" &&
    // A new account must set an IMAP password; on edit, blank keeps the existing sealed secret.
    (editingId !== null || form.imap_password !== "");

  return (
    <div className="imap">
      <header className="imap__head">
        <h1>Mail accounts</h1>
        <p>
          Give the agent IMAP read + SMTP send access to your mailboxes. Each account&rsquo;s password
          is sealed in your vault — never shown back or handed to a model. The connection details
          (host, port, username) are stored so the agent can reach the right server.
        </p>
      </header>

      {error ? <div className="imap__err">{error}</div> : null}

      <section className="imap__add">
        <h2>{editingId ? "Edit account" : "Add an account"}</h2>
        <label>
          Name
          <input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Personal"
            disabled={busy}
          />
        </label>

        <h3>IMAP (reading)</h3>
        <div className="imap__grid">
          <label>
            Host
            <input
              value={form.imap_host}
              onChange={(e) => set("imap_host", e.target.value)}
              placeholder="imap.gmail.com"
              disabled={busy}
            />
          </label>
          <label className="imap__port">
            Port
            <input
              value={form.imap_port}
              onChange={(e) => set("imap_port", e.target.value)}
              placeholder="993"
              inputMode="numeric"
              disabled={busy}
            />
          </label>
        </div>
        <label>
          Username
          <input
            value={form.imap_user}
            onChange={(e) => set("imap_user", e.target.value)}
            placeholder="you@example.com"
            autoComplete="off"
            disabled={busy}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="new-password"
            value={form.imap_password}
            onChange={(e) => set("imap_password", e.target.value)}
            placeholder={editingId ? "leave blank to keep current password" : "app password if your provider requires one"}
            disabled={busy}
          />
        </label>

        <h3>SMTP (sending) — optional</h3>
        <p className="imap__muted">
          Leave blank for a read-only account. To send mail, add the SMTP host and password.
        </p>
        <div className="imap__grid">
          <label>
            Host
            <input
              value={form.smtp_host}
              onChange={(e) => set("smtp_host", e.target.value)}
              placeholder="smtp.gmail.com"
              disabled={busy}
            />
          </label>
          <label className="imap__port">
            Port
            <input
              value={form.smtp_port}
              onChange={(e) => set("smtp_port", e.target.value)}
              placeholder="587"
              inputMode="numeric"
              disabled={busy}
            />
          </label>
        </div>
        <label>
          Username
          <input
            value={form.smtp_user}
            onChange={(e) => set("smtp_user", e.target.value)}
            placeholder="defaults to the IMAP username"
            autoComplete="off"
            disabled={busy}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="new-password"
            value={form.smtp_password}
            onChange={(e) => set("smtp_password", e.target.value)}
            placeholder={editingId ? "leave blank to keep current password" : "app password if your provider requires one"}
            disabled={busy}
          />
        </label>
        <label>
          From address
          <input
            value={form.smtp_from}
            onChange={(e) => set("smtp_from", e.target.value)}
            placeholder="defaults to the SMTP/IMAP username"
            disabled={busy}
          />
        </label>

        <div className="imap__actions">
          <button className="imap__btn" onClick={() => void save()} disabled={!canSave}>
            {editingId ? "Save changes" : "Add account"}
          </button>
          {editingId ? (
            <button
              type="button"
              className="imap__btn imap__btn--quiet"
              onClick={resetForm}
              disabled={busy}
            >
              Cancel
            </button>
          ) : null}
        </div>
      </section>

      <section className="imap__list">
        {accounts === null ? (
          <p className="imap__muted">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="imap__muted">No mail accounts yet — add one above.</p>
        ) : (
          accounts.map((a) => (
            <div className="imap__row" key={a.id}>
              <div className="imap__row-top">
                <strong>{a.name}</strong>
                <span className="imap__chip">password sealed</span>
                <button
                  className="imap__btn imap__btn--quiet"
                  onClick={() => edit(a)}
                  disabled={busy}
                >
                  Edit
                </button>
                <button
                  className="imap__btn imap__btn--quiet"
                  onClick={() => void remove(a.id)}
                  disabled={busy}
                >
                  Remove
                </button>
              </div>
              <dl className="imap__meta">
                <div>
                  <dt>IMAP</dt>
                  <dd>
                    {a.imap_user} @ {a.imap_host}:{a.imap_port}
                  </dd>
                </div>
                {a.smtp_host ? (
                  <div>
                    <dt>SMTP</dt>
                    <dd>
                      {a.smtp_user || a.imap_user} @ {a.smtp_host}:{a.smtp_port}
                      {a.smtp_from ? ` (from ${a.smtp_from})` : ""}
                    </dd>
                  </div>
                ) : (
                  <div>
                    <dt>SMTP</dt>
                    <dd className="imap__muted">read-only (no sending)</dd>
                  </div>
                )}
              </dl>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
