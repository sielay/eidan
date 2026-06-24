// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

// Shared Connections dashboard for the social plugins. Each plugin's frontend/Connections.tsx is a
// ~3-line wrapper passing a config here, so all 8 platforms share one UI.
//
// Model: **OAuth apps** (client id/secret) are first-class, set up per provider — you can register
// MORE THAN ONE (e.g. personal + work) and reuse each across many accounts. Below them you add
// **connections** (accounts), each PICKING which app authorises it. Mastodon registers an app per
// instance automatically (no app picker); Bluesky uses a handle + app password (no OAuth app). Every
// connection supports Test, Reauth/Reconnect, and Disconnect. Secrets are sealed server-side and
// never read back.
import * as React from "react";

import { authFetch } from "@/lib/auth";

export type SocialFlavor = "oauth2" | "oauth2_pkce" | "dynamic_app" | "app_password";

export interface SocialConnectionsProps {
  name: string; // 'social-x' => /p/social-x, /api/social-x/accounts
  title: string; // 'X (Twitter)'
  flavor: SocialFlavor;
  blurb?: string;
  setupHelp?: React.ReactNode;
  defaultScopes?: string; // prefilled into the app's editable scope field (provider-specific)
  // App kinds (e.g. LinkedIn member vs organization): picking one on Add app sets its scope preset +
  // tags the app; connections made with that app inherit the kind. `needsTarget` (e.g. LinkedIn
  // organization) asks for a per-connection target (which Page) on connect. Absent => single kind.
  connTypes?: Array<{ value: string; label: string; scopes?: string; needsTarget?: boolean; targetLabel?: string; targetHelp?: string }>;
}

interface Account {
  id: string;
  name: string;
  slug: string;
  host: string;
  external_handle: string;
  status: string;
  token_expires_at: string | null;
  app_name?: string | null;
  context?: string;
  conn_type?: string | null;
}

interface OAuthApp {
  id: string;
  name: string;
  type?: string;
}

type Chip = "connected" | "expiring" | "expired" | "pending";

function chipOf(a: Account): Chip {
  if (a.status !== "active") return "pending";
  if (!a.token_expires_at) return "connected";
  const exp = new Date(a.token_expires_at).getTime();
  const now = Date.now();
  if (exp <= now) return "expired";
  if (exp - now < 3 * 24 * 60 * 60 * 1000) return "expiring";
  return "connected";
}

const CHIP_LABEL: Record<Chip, string> = {
  connected: "connected",
  expiring: "expiring soon",
  expired: "expired",
  pending: "not connected",
};

export default function SocialConnections(props: SocialConnectionsProps): React.ReactElement {
  const apiBase = `/api/${props.name}/accounts`;
  const isAppPassword = props.flavor === "app_password";
  const isDynamic = props.flavor === "dynamic_app";
  const usesApps = props.flavor === "oauth2" || props.flavor === "oauth2_pkce";

  const [accounts, setAccounts] = React.useState<Account[] | null>(null);
  const [apps, setApps] = React.useState<OAuthApp[]>([]);
  const [redirectUri, setRedirectUri] = React.useState("");
  const [copied, setCopied] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  // add-app form
  const [showAppForm, setShowAppForm] = React.useState(false);
  const [appName, setAppName] = React.useState("");
  const [appKind, setAppKind] = React.useState(props.connTypes?.[0]?.value ?? "");
  const [clientId, setClientId] = React.useState("");
  const [clientSecret, setClientSecret] = React.useState("");
  const [appScopes, setAppScopes] = React.useState(props.connTypes?.[0]?.scopes ?? props.defaultScopes ?? "");

  // edit-app form (per app)
  const [editApp, setEditApp] = React.useState<string | null>(null);
  const [eKind, setEKind] = React.useState("");
  const [eClientId, setEClientId] = React.useState("");
  const [eClientSecret, setEClientSecret] = React.useState("");
  const [eScopes, setEScopes] = React.useState("");

  // account form
  const [name, setName] = React.useState("");
  const [appId, setAppId] = React.useState("");
  const [host, setHost] = React.useState("");
  const [handle, setHandle] = React.useState("");
  const [appPassword, setAppPassword] = React.useState("");

  const [tests, setTests] = React.useState<Record<string, { busy: boolean; ok?: boolean; msg?: string }>>({});

  // post-connect target (e.g. LinkedIn Page) picker, per account
  const [targetsFor, setTargetsFor] = React.useState<Record<string, Array<{ id: string; label: string }>>>({});
  const [targetBusy, setTargetBusy] = React.useState<string | null>(null);
  const [picked, setPicked] = React.useState<Record<string, string>>({});

  // inline edit (rename + agent context)
  const [editing, setEditing] = React.useState<string | null>(null);
  const [editName, setEditName] = React.useState("");
  const [editContext, setEditContext] = React.useState("");

  const load = React.useCallback(async () => {
    try {
      const r = await authFetch(apiBase);
      if (!r.ok) throw new Error(`load failed (${r.status})`);
      const j = (await r.json()) as { accounts: Account[]; apps?: OAuthApp[]; redirect_uri?: string };
      setAccounts(j.accounts);
      const list = j.apps ?? [];
      setApps(list);
      setAppId((prev) => prev || (list.length === 1 ? list[0]!.id : ""));
      setRedirectUri(j.redirect_uri ?? "");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load accounts");
    }
  }, [apiBase]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Reset busy if restored from bfcache (a Connect navigates away; Back restores stale busy=true).
  React.useEffect(() => {
    const onShow = (e: PageTransitionEvent): void => {
      if (e.persisted) setBusy(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  const createApp = React.useCallback(async () => {
    if (!appName.trim() || !clientId.trim() || !clientSecret.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await authFetch(apiBase, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          create_app: {
            name: appName.trim(),
            client_id: clientId.trim(),
            client_secret: clientSecret.trim(),
            scopes: appScopes.trim(),
            type: appKind,
          },
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; id?: string; error?: string };
      if (!r.ok || !j.ok) throw new Error(j.error ?? `save failed (${r.status})`);
      setAppName("");
      setClientId("");
      setClientSecret("");
      setShowAppForm(false);
      if (j.id) setAppId(j.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to add app");
    } finally {
      setBusy(false);
    }
  }, [apiBase, appName, appKind, clientId, clientSecret, appScopes, load]);

  const openAppForm = React.useCallback(() => {
    const first = props.connTypes?.[0];
    setAppKind(first?.value ?? "");
    setAppScopes(first?.scopes ?? props.defaultScopes ?? "");
    setShowAppForm(true);
  }, [props.connTypes, props.defaultScopes]);

  const pickAppKind = React.useCallback(
    (value: string) => {
      setAppKind(value);
      const kind = props.connTypes?.find((c) => c.value === value);
      if (kind?.scopes) setAppScopes(kind.scopes);
    },
    [props.connTypes],
  );

  const startEditApp = React.useCallback(
    (ap: OAuthApp) => {
      setEditApp(ap.id);
      const kind = props.connTypes?.find((c) => c.value === ap.type) ?? props.connTypes?.[0];
      setEKind(ap.type ?? kind?.value ?? "");
      setEScopes(kind?.scopes ?? props.defaultScopes ?? "");
      setEClientId("");
      setEClientSecret("");
    },
    [props.connTypes, props.defaultScopes],
  );

  const pickEditKind = React.useCallback(
    (value: string) => {
      setEKind(value);
      const kind = props.connTypes?.find((c) => c.value === value);
      if (kind?.scopes) setEScopes(kind.scopes);
    },
    [props.connTypes],
  );

  const saveEditApp = React.useCallback(async () => {
    if (!editApp || !eClientId.trim() || !eClientSecret.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await authFetch(apiBase, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          update_app: { id: editApp, client_id: eClientId.trim(), client_secret: eClientSecret.trim(), scopes: eScopes.trim(), type: eKind },
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!r.ok || !j.ok) throw new Error(j.error ?? `save failed (${r.status})`);
      setEditApp(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to update app");
    } finally {
      setBusy(false);
    }
  }, [apiBase, editApp, eClientId, eClientSecret, eScopes, eKind, load]);

  const deleteApp = React.useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        const r = await authFetch(apiBase, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ delete_app: id }),
        });
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!r.ok || !j.ok) throw new Error(j.error ?? `delete failed (${r.status})`);
        if (appId === id) setAppId("");
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "failed to delete app");
      } finally {
        setBusy(false);
      }
    },
    [apiBase, appId, load],
  );

  const canConnect =
    name.trim().length > 0 &&
    (isAppPassword
      ? handle.trim().length > 0 && appPassword.trim().length > 0
      : isDynamic
        ? host.trim().length > 0
        : appId.length > 0); // a needsTarget connection can pick its Page after connecting

  const connect = React.useCallback(async () => {
    if (!canConnect) return;
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, string> = { name: name.trim() };
      if (isAppPassword) {
        payload["handle"] = handle.trim();
        payload["app_password"] = appPassword.trim();
      } else if (isDynamic) {
        payload["host"] = host.trim();
      } else {
        payload["app_id"] = appId;
      }
      const r = await authFetch(apiBase, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = (await r.json().catch(() => ({}))) as { auth_url?: string; ok?: boolean; error?: string };
      if (!r.ok) throw new Error(j.error ?? `connect failed (${r.status})`);
      if (j.auth_url) {
        window.location.assign(j.auth_url); // OAuth flavours: go to consent
        return;
      }
      // App-password (Bluesky): connected synchronously.
      setName("");
      setHandle("");
      setAppPassword("");
      await load();
      setBusy(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to start connection");
      setBusy(false);
    }
  }, [apiBase, canConnect, isAppPassword, isDynamic, name, appId, host, handle, appPassword, load]);

  // Reauth/reconnect for ANY connection. OAuth flavours re-run consent server-side (reusing the app
  // the connection was made with). App-password (Bluesky) has no consent step, so we prefill the form
  // for the operator to re-enter the app password (a re-save upserts the same account).
  const reconnect = React.useCallback(
    async (a: Account) => {
      if (isAppPassword) {
        setName(a.name);
        setHandle(a.external_handle);
        setAppPassword("");
        setError(`Re-enter the app password for "${a.name}" below, then Connect.`);
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const r = await authFetch(apiBase, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reconnect: a.id }),
        });
        const j = (await r.json().catch(() => ({}))) as { auth_url?: string; error?: string };
        if (!r.ok || !j.auth_url) throw new Error(j.error ?? `reauth failed (${r.status})`);
        window.location.assign(j.auth_url);
      } catch (e) {
        setError(e instanceof Error ? e.message : "failed to reauth");
        setBusy(false);
      }
    },
    [apiBase, isAppPassword],
  );

  // Engine-side test: resolves the sealed token (refreshing if needed) and calls the platform.
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

  const startEdit = React.useCallback((a: Account) => {
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

  const loadTargets = React.useCallback(
    async (id: string) => {
      setTargetBusy(id);
      setError(null);
      try {
        const r = await authFetch(apiBase, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ list_targets: id }),
        });
        const j = (await r.json().catch(() => ({}))) as { targets?: Array<{ id: string; label: string }>; error?: string };
        if (!r.ok) throw new Error(j.error ?? `failed (${r.status})`);
        setTargetsFor((m) => ({ ...m, [id]: j.targets ?? [] }));
        if (j.error) setError(j.error);
      } catch (e) {
        setError(e instanceof Error ? e.message : "failed to list pages");
      } finally {
        setTargetBusy(null);
      }
    },
    [apiBase],
  );

  const chooseTarget = React.useCallback(
    async (id: string) => {
      const list = targetsFor[id] ?? [];
      const targetId = picked[id] || list[0]?.id;
      if (!targetId) return;
      const label = list.find((t) => t.id === targetId)?.label ?? "";
      setBusy(true);
      setError(null);
      try {
        const r = await authFetch(apiBase, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ set_target: { id, target: targetId, label } }),
        });
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (!r.ok || !j.ok) throw new Error(j.error ?? `failed (${r.status})`);
        setTargetsFor((m) => {
          const n = { ...m };
          delete n[id];
          return n;
        });
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "failed to set page");
      } finally {
        setBusy(false);
      }
    },
    [apiBase, targetsFor, picked, load],
  );

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

  const redirectBox = redirectUri ? (
    <div className="sconn__callback">
      <span className="sconn__muted">Authorized redirect URI (register this in each app, exactly):</span>
      <code className="sconn__cburl">{redirectUri}</code>
      <button
        type="button"
        className="sconn__btn sconn__btn--quiet"
        onClick={() => {
          void navigator.clipboard?.writeText(redirectUri);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  ) : null;

  return (
    <div className="sconn">
      <header className="sconn__head">
        <h1>{props.title}</h1>
        {props.blurb ? <p>{props.blurb}</p> : null}
      </header>

      {error ? <div className="sconn__err">{error}</div> : null}

      {/* OAuth apps — register one or more sets of client credentials; reuse each across accounts. */}
      {usesApps ? (
        <section className="sconn__add">
          <h2>OAuth apps</h2>
          {props.setupHelp ? <div className="sconn__muted">{props.setupHelp}</div> : null}
          {redirectBox}
          {apps.length === 0 ? (
            <p className="sconn__muted">No apps yet — add your app’s client ID + secret to connect accounts.</p>
          ) : (
            apps.map((ap) => (
              <div key={ap.id}>
                <div className="sconn__row-top">
                  <strong>{ap.name}</strong>
                  <span className="sconn__chip sconn__chip--connected">
                    {props.connTypes?.find((c) => c.value === ap.type)?.label ?? "app"}
                  </span>
                  <button className="sconn__btn sconn__btn--quiet" onClick={() => startEditApp(ap)} disabled={busy}>
                    Edit
                  </button>
                  <button className="sconn__btn sconn__btn--quiet" onClick={() => void deleteApp(ap.id)} disabled={busy}>
                    Delete
                  </button>
                </div>
                {editApp === ap.id ? (
                  <div className="sconn__edit">
                    {props.connTypes && props.connTypes.length ? (
                      <label>
                        App kind
                        <select value={eKind} onChange={(e) => pickEditKind(e.target.value)} disabled={busy}>
                          {props.connTypes.map((ct) => (
                            <option value={ct.value} key={ct.value}>
                              {ct.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <label>
                      OAuth client ID
                      <input value={eClientId} onChange={(e) => setEClientId(e.target.value)} autoComplete="off" disabled={busy} />
                    </label>
                    <label>
                      OAuth client secret
                      <input type="password" value={eClientSecret} onChange={(e) => setEClientSecret(e.target.value)} autoComplete="off" disabled={busy} />
                    </label>
                    <label>
                      Scopes
                      <input value={eScopes} onChange={(e) => setEScopes(e.target.value)} autoComplete="off" disabled={busy} />
                    </label>
                    <div className="sconn__row-top">
                      <button className="sconn__btn" onClick={() => void saveEditApp()} disabled={busy || !eClientId.trim() || !eClientSecret.trim()}>
                        Save app
                      </button>
                      <button className="sconn__btn sconn__btn--quiet" onClick={() => setEditApp(null)} disabled={busy}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ))
          )}
          {showAppForm ? (
            <>
              {props.connTypes && props.connTypes.length ? (
                <label>
                  App kind
                  <select value={appKind} onChange={(e) => pickAppKind(e.target.value)} disabled={busy}>
                    {props.connTypes.map((ct) => (
                      <option value={ct.value} key={ct.value}>
                        {ct.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label>
                App name
                <input value={appName} onChange={(e) => setAppName(e.target.value)} placeholder="Personal app" disabled={busy} />
              </label>
              <label>
                OAuth client ID
                <input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" disabled={busy} />
              </label>
              <label>
                OAuth client secret
                <input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  autoComplete="off"
                  disabled={busy}
                />
              </label>
              <label>
                Scopes
                <input value={appScopes} onChange={(e) => setAppScopes(e.target.value)} autoComplete="off" disabled={busy} />
                <span className="sconn__muted">
                  Space-separated; must match the products enabled on this app. (LinkedIn gates scopes by product —
                  e.g. a Pages app uses organization scopes and can’t mix with Sign-In/Share.)
                </span>
              </label>
              <div className="sconn__row-top">
                <button
                  className="sconn__btn"
                  onClick={() => void createApp()}
                  disabled={busy || !appName.trim() || !clientId.trim() || !clientSecret.trim()}
                >
                  Save app
                </button>
                <button className="sconn__btn sconn__btn--quiet" onClick={() => setShowAppForm(false)} disabled={busy}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <button className="sconn__btn sconn__btn--quiet" onClick={openAppForm} disabled={busy}>
              Add app
            </button>
          )}
        </section>
      ) : null}

      {/* Add a connection (account). */}
      <section className="sconn__add">
        <h2>{isAppPassword ? "Connect an account" : "Add an account"}</h2>
        {!usesApps && props.setupHelp ? <div className="sconn__muted">{props.setupHelp}</div> : null}
        {isDynamic ? redirectBox : null}

        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Personal" disabled={busy} />
        </label>

        {usesApps ? (
          <label>
            OAuth app
            <select value={appId} onChange={(e) => setAppId(e.target.value)} disabled={busy || apps.length === 0}>
              <option value="">{apps.length === 0 ? "— add an app above first —" : "— choose an app —"}</option>
              {apps.map((ap) => (
                <option value={ap.id} key={ap.id}>
                  {ap.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {isDynamic ? (
          <label>
            Instance host
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="mastodon.social"
              autoComplete="off"
              disabled={busy}
            />
          </label>
        ) : null}

        {isAppPassword ? (
          <>
            <label>
              Handle
              <input
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder="you.bsky.social"
                autoComplete="off"
                disabled={busy}
              />
            </label>
            <label>
              App password
              <input
                type="password"
                value={appPassword}
                onChange={(e) => setAppPassword(e.target.value)}
                placeholder="xxxx-xxxx-xxxx-xxxx"
                autoComplete="off"
                disabled={busy}
              />
            </label>
          </>
        ) : null}

        <button className="sconn__btn" onClick={() => void connect()} disabled={busy || !canConnect}>
          {isAppPassword ? "Connect" : `Connect ${props.title}`}
        </button>
      </section>

      <section className="sconn__list">
        {accounts === null ? (
          <p className="sconn__muted">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="sconn__muted">No accounts connected yet — add one above.</p>
        ) : (
          accounts.map((a) => {
            const chip = chipOf(a);
            const t = tests[a.id];
            const aKind = props.connTypes?.find((c) => c.value === a.conn_type);
            const aNeedsTarget = !!aKind?.needsTarget;
            const tList = targetsFor[a.id];
            return (
              <div className="sconn__row" key={a.id}>
                <div className="sconn__row-top">
                  <strong>{a.name}</strong>
                  {a.external_handle ? (
                    <span className="sconn__handle">
                      {a.external_handle}
                      {a.host ? `@${a.host}` : ""}
                    </span>
                  ) : null}
                  {a.conn_type ? <span className="sconn__muted">{a.conn_type}</span> : null}
                  {a.app_name ? <span className="sconn__muted">via {a.app_name}</span> : null}
                  <span className={`sconn__chip sconn__chip--${chip}`}>{CHIP_LABEL[chip]}</span>
                  <button
                    className="sconn__btn sconn__btn--quiet"
                    onClick={() => void test(a.id)}
                    disabled={busy || t?.busy || chip === "pending"}
                    title="Resolve the stored credential and call the platform to confirm it works."
                  >
                    {t?.busy ? "Testing…" : "Test"}
                  </button>
                  <button className="sconn__btn sconn__btn--quiet" onClick={() => startEdit(a)} disabled={busy}>
                    Edit
                  </button>
                  <button
                    className="sconn__btn sconn__btn--quiet"
                    onClick={() => void reconnect(a)}
                    disabled={busy}
                    title={isAppPassword ? "Re-enter the app password for this account." : "Re-run consent reusing this account's app — no re-entry."}
                  >
                    {isAppPassword ? "Reauth" : "Reconnect"}
                  </button>
                  <button className="sconn__btn sconn__btn--quiet" onClick={() => void disconnect(a.id)} disabled={busy}>
                    {chip === "pending" ? "Remove" : "Disconnect"}
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
                        placeholder="e.g. Main brand account — professional tone, no politics. Use for product launches."
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
                {aNeedsTarget ? (
                  <div className="sconn__edit">
                    {tList ? (
                      tList.length === 0 ? (
                        <span className="sconn__muted">No pages found for this token (are you an admin of a Page?).</span>
                      ) : (
                        <div className="sconn__row-top">
                          <select
                            value={picked[a.id] ?? tList[0]?.id ?? ""}
                            onChange={(e) => setPicked((p) => ({ ...p, [a.id]: e.target.value }))}
                            disabled={busy}
                          >
                            {tList.map((tg) => (
                              <option value={tg.id} key={tg.id}>
                                {tg.label}
                              </option>
                            ))}
                          </select>
                          <button className="sconn__btn" onClick={() => void chooseTarget(a.id)} disabled={busy}>
                            Set page
                          </button>
                        </div>
                      )
                    ) : (
                      <button
                        className="sconn__btn sconn__btn--quiet"
                        onClick={() => void loadTargets(a.id)}
                        disabled={busy || targetBusy === a.id}
                      >
                        {targetBusy === a.id ? "Loading pages…" : a.external_handle ? "Change page" : "Choose page"}
                      </button>
                    )}
                  </div>
                ) : null}
                {t && !t.busy && t.msg ? (
                  <p className={t.ok ? "sconn__test sconn__test--ok" : "sconn__test sconn__test--bad"}>
                    {t.ok ? "✓" : "✗"} {t.msg}
                  </p>
                ) : null}
                {chip === "pending" ? (
                  <p className="sconn__muted">
                    Connection wasn’t completed — {isAppPassword ? "re-enter it above" : "use Reconnect"} or remove it.
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
