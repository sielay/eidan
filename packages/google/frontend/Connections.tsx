// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { authFetch } from "@/lib/auth";

interface Account {
  id: string;
  name: string;
  slug: string;
  email: string;
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
      const r = await authFetch("/api/google/accounts");
      if (!r.ok) throw new Error(`load failed (${r.status})`);
      const j = (await r.json()) as { accounts: Account[]; redirect_uri?: string };
      setAccounts(j.accounts);
      setRedirectUri(j.redirect_uri ?? "");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load accounts");
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Reset the busy lock if the page is restored from the browser's back/forward cache (bfcache).
  // A Connect navigates to Google with busy=true; pressing Back restores this page from bfcache with
  // that stale state, which would otherwise leave every button (incl. Reconnect) stuck disabled.
  React.useEffect(() => {
    const onShow = (e: PageTransitionEvent): void => {
      if (e.persisted) setBusy(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  // Connect: seal the operator's OAuth client, create a pending account, then send the browser to
  // Google's consent screen. The Callback page completes the exchange and returns here.
  const connect = React.useCallback(async () => {
    if (!name.trim() || !clientId.trim() || !clientSecret.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await authFetch("/api/google/accounts", {
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
      // The client is sealed server-side (in the vault) by the POST above, so the callback finishes
      // the exchange entirely server-side — the secret never round-trips through the browser.
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
        const r = await authFetch(`/api/google/accounts?id=${encodeURIComponent(id)}`, { method: "DELETE" });
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

  // Reconnect: re-run Google consent reusing the STORED client — the engine reads the (write-only)
  // vault and rebuilds the consent URL, so nothing is re-entered. One click → straight to Google.
  const reconnect = React.useCallback(async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await authFetch("/api/google/accounts", {
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
    <div className="gconn">
      <header className="gconn__head">
        <h1>Google</h1>
        <p>
          Connect a Gmail account so the agent can read your mail. You provide your own Google OAuth
          client (ID + secret); both — and the resulting refresh token — are sealed in your vault, never
          shown back or handed to a model. Access is read-only (<code>gmail.readonly</code>).
        </p>
      </header>

      {error ? <div className="gconn__err">{error}</div> : null}

      <section className="gconn__add">
        <h2>Connect an account</h2>
        <p className="gconn__muted">
          In Google Cloud Console: enable the <strong>Gmail API</strong>, create an OAuth client of
          type <strong>Web application</strong>, and add the URL below as an{" "}
          <em>Authorized redirect URI</em>. Then paste the client ID and secret here. To reconnect an
          existing account, use its <strong>Reconnect</strong> button — no re-entry needed.
        </p>
        {redirectUri ? (
          <div className="gconn__callback">
            <span className="gconn__muted">Authorized redirect URI (register this exactly):</span>
            <code className="gconn__cburl">{redirectUri}</code>
            <button
              type="button"
              className="gconn__btn gconn__btn--quiet"
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
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Personal"
            disabled={busy}
          />
        </label>
        <label>
          OAuth client ID
          <input
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="…apps.googleusercontent.com"
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
            placeholder="GOCSPX-…"
            autoComplete="off"
            disabled={busy}
          />
        </label>
        <button
          className="gconn__btn"
          onClick={() => void connect()}
          disabled={busy || !name.trim() || !clientId.trim() || !clientSecret.trim()}
        >
          Connect with Google
        </button>
      </section>

      <section className="gconn__list">
        {accounts === null ? (
          <p className="gconn__muted">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="gconn__muted">No accounts connected yet — connect one above.</p>
        ) : (
          accounts.map((a) => {
            const pending = a.status !== "active";
            return (
              <div className="gconn__row" key={a.id}>
                <div className="gconn__row-top">
                  <strong>{a.name}</strong>
                  {a.email ? <span className="gconn__email">{a.email}</span> : null}
                  <span className={`gconn__chip${pending ? " gconn__chip--pending" : ""}`}>
                    {pending ? "not connected" : "connected"}
                  </span>
                  <button
                    className="gconn__btn gconn__btn--quiet"
                    onClick={() => void reconnect(a.id)}
                    disabled={busy}
                    title="Re-run Google consent reusing your stored client — no re-entry. (Refresh tokens expire after 7 days on unverified apps.)"
                  >
                    Reconnect
                  </button>
                  <button
                    className="gconn__btn gconn__btn--quiet"
                    onClick={() => void disconnect(a.id)}
                    disabled={busy}
                  >
                    {pending ? "Remove" : "Disconnect"}
                  </button>
                </div>
                {pending ? (
                  <p className="gconn__muted">
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
