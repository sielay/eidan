// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { authFetch } from "@/lib/auth";

interface Account {
  id: string;
  name: string;
  slug: string;
  org: string;
  status: string;
}

export default function Connections(): React.ReactElement {
  const [accounts, setAccounts] = React.useState<Account[] | null>(null);
  const [redirectUri, setRedirectUri] = React.useState<string>("");
  const [copied, setCopied] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [name, setName] = React.useState("");
  const [clientId, setClientId] = React.useState("");
  const [clientSecret, setClientSecret] = React.useState("");

  const load = React.useCallback(async () => {
    try {
      const r = await authFetch("/api/finance-xero/accounts");
      if (!r.ok) throw new Error(`load failed (${r.status})`);
      const j = (await r.json()) as { accounts: Account[]; redirect_uri?: string };
      setAccounts(j.accounts);
      setRedirectUri(j.redirect_uri ?? "");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load organisations");
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Reset the busy lock if the page is restored from the browser's back/forward cache (bfcache):
  // a Connect navigates to Xero with busy=true; pressing Back would otherwise leave buttons stuck.
  React.useEffect(() => {
    const onShow = (e: PageTransitionEvent): void => {
      if (e.persisted) setBusy(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  // Connect: seal the operator's OAuth client, create a pending org, then send the browser to Xero's
  // consent screen. The Callback page completes the exchange and returns here.
  const connect = React.useCallback(async () => {
    if (!name.trim() || !clientId.trim() || !clientSecret.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await authFetch("/api/finance-xero/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          client_id: clientId.trim(),
          client_secret: clientSecret.trim(),
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { auth_url?: string; error?: string };
      if (!r.ok || !j.auth_url) throw new Error(j.error ?? `connect failed (${r.status})`);
      window.location.assign(j.auth_url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to start connection");
      setBusy(false);
    }
  }, [name, clientId, clientSecret]);

  const disconnect = React.useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        const r = await authFetch(`/api/finance-xero/accounts?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!r.ok) throw new Error(`disconnect failed (${r.status})`);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "failed to disconnect");
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  // Reconnect: re-run Xero consent reusing the STORED client — the engine reads the (write-only) vault
  // and rebuilds the consent URL, so nothing is re-entered. One click → straight to Xero.
  const reconnect = React.useCallback(async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await authFetch("/api/finance-xero/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reconnect: id }),
      });
      const j = (await r.json().catch(() => ({}))) as { auth_url?: string; error?: string };
      if (!r.ok || !j.auth_url) throw new Error(j.error ?? `reconnect failed (${r.status})`);
      window.location.assign(j.auth_url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to reconnect");
      setBusy(false);
    }
  }, []);

  return (
    <div className="xconn">
      <header className="xconn__head">
        <h1>Xero</h1>
        <p>
          Connect a Xero organisation so the agent can read your accounting — invoices, contacts, the
          chart of accounts, bank transactions, and P&amp;L / balance-sheet reports. You provide your own
          Xero OAuth client (ID + secret); both — and the resulting refresh token — are sealed in your
          vault, never shown back or handed to a model. Access is <strong>read-only</strong>.
        </p>
      </header>

      {error ? <div className="xconn__err">{error}</div> : null}

      <section className="xconn__add">
        <h2>Connect an organisation</h2>
        <p className="xconn__muted">
          At <em>developer.xero.com</em> → My Apps: create a <strong>Web app</strong>, enable the
          read-only accounting scopes, and add the URL below as a <em>Redirect URI</em>. Then paste the
          client ID and secret here. To reconnect an existing org, use its <strong>Reconnect</strong>{" "}
          button — no re-entry needed.
        </p>
        {redirectUri ? (
          <div className="xconn__callback">
            <span className="xconn__muted">Redirect URI (register this exactly):</span>
            <code className="xconn__cburl">{redirectUri}</code>
            <button
              type="button"
              className="xconn__btn xconn__btn--quiet"
              onClick={() => {
                void navigator.clipboard?.writeText(redirectUri);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        ) : null}
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My company" disabled={busy} />
        </label>
        <label>
          OAuth client ID
          <input
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="Xero app client id"
            autoComplete="off"
            disabled={busy}
          />
        </label>
        <label>
          OAuth client secret
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder="Xero app client secret"
            autoComplete="off"
            disabled={busy}
          />
        </label>
        <button
          className="xconn__btn"
          onClick={() => void connect()}
          disabled={busy || !name.trim() || !clientId.trim() || !clientSecret.trim()}
        >
          Connect with Xero
        </button>
      </section>

      <section className="xconn__list">
        {accounts === null ? (
          <p className="xconn__muted">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="xconn__muted">No organisations connected yet — connect one above.</p>
        ) : (
          accounts.map((a) => {
            const pending = a.status !== "active";
            return (
              <div className="xconn__row" key={a.id}>
                <div className="xconn__row-top">
                  <strong>{a.name}</strong>
                  {a.org ? <span className="xconn__org">{a.org}</span> : null}
                  <span className={`xconn__chip${pending ? " xconn__chip--pending" : ""}`}>
                    {pending ? "not connected" : "connected"}
                  </span>
                  <button
                    className="xconn__btn xconn__btn--quiet"
                    onClick={() => void reconnect(a.id)}
                    disabled={busy}
                    title="Re-run Xero consent reusing your stored client — no re-entry."
                  >
                    Reconnect
                  </button>
                  <button className="xconn__btn xconn__btn--quiet" onClick={() => void disconnect(a.id)} disabled={busy}>
                    {pending ? "Remove" : "Disconnect"}
                  </button>
                </div>
                {pending ? (
                  <p className="xconn__muted">
                    Consent wasn’t completed — re-enter the same name above to retry, or remove it.
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
