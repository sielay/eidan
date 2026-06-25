// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

// Charles · Domains — the domains inventory screen (Surface B: Next-reads-Postgres over the bundle's
// /api/charles/domains[/registrars] routes). Built on the core design system (tokens + .card/.field/
// .input/.btn/.loglist/.pill/.screen-sub from globals.css) so it matches the Ventures screen.

import * as React from "react";

import { authFetch } from "@/lib/auth";

interface Domain {
  id: string;
  name: string;
  registrar: string;
  status: string;
  expires_at: string | null;
  auto_renew: boolean | null;
  venture_id?: string;
  venture_name?: string;
}
interface RegistrarAccount {
  id: string;
  registrar: string;
  name: string;
}

const REGISTRARS: Array<[string, string]> = [["godaddy", "GoDaddy"], ["cyberfolks", "cyberfolks"]];
function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export default function Domains(): React.ReactElement {
  const [domains, setDomains] = React.useState<Domain[]>([]);
  const [accounts, setAccounts] = React.useState<RegistrarAccount[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);
  const [info, setInfo] = React.useState<string | null>(null);
  const [sheet, setSheet] = React.useState<null | "add" | "connect">(null);
  const [busy, setBusy] = React.useState(false);
  const [importing, setImporting] = React.useState<string | null>(null);

  const loadDomains = React.useCallback(async () => {
    const r = await authFetch("/api/charles/domains");
    const j = (await r.json().catch(() => ({}))) as { domains?: Domain[] };
    setDomains(j.domains ?? []);
  }, []);
  const loadAccounts = React.useCallback(async () => {
    const r = await authFetch("/api/charles/domains/registrars");
    const j = (await r.json().catch(() => ({}))) as { accounts?: RegistrarAccount[] };
    setAccounts(j.accounts ?? []);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        await Promise.all([loadDomains(), loadAccounts()]);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [loadDomains, loadAccounts]);

  async function addDomain(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setErr(null);
    try {
      const r = await authFetch("/api/charles/domains", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: String(f.get("name") ?? "").trim(),
          registrar: String(f.get("registrar") ?? "manual"),
          expires_at: String(f.get("expires_at") ?? "") || undefined,
          auto_renew: f.get("auto_renew") === "on" || undefined,
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? `add failed (${r.status})`);
      setSheet(null);
      await loadDomains();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function connectRegistrar(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setErr(null);
    try {
      const r = await authFetch("/api/charles/domains/registrars", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "connect",
          registrar: String(f.get("registrar") ?? ""),
          name: String(f.get("name") ?? "").trim(),
          api_key: String(f.get("api_key") ?? ""),
          api_secret: String(f.get("api_secret") ?? ""),
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? `connect failed (${r.status})`);
      setSheet(null);
      await loadAccounts();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function importDomains(accountId: string): Promise<void> {
    setImporting(accountId);
    setErr(null);
    setInfo(null);
    try {
      const r = await authFetch("/api/charles/domains/registrars", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "import", account_id: accountId }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; imported?: number; updated?: number };
      if (!r.ok) throw new Error(j.error ?? `import failed (${r.status})`);
      const n = (j.imported ?? 0) + (j.updated ?? 0);
      setInfo(typeof j.imported === "number" ? `Imported ${j.imported ?? 0}, updated ${j.updated ?? 0}.` : `Imported ${n} domains.`);
      await loadDomains();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(null);
    }
  }

  return (
    <div style={{ padding: "var(--s5)", maxWidth: 880, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--s3)", marginBottom: "var(--s4)" }}>
        <div>
          <h2 style={{ fontSize: "var(--fs-20)" }}>Domains</h2>
          <p className="screen-sub" style={{ margin: 0 }}>Your registered domains — add by hand or import from a registrar.</p>
        </div>
        <div style={{ display: "flex", gap: "var(--s2)", flexShrink: 0 }}>
          <button className="btn btn--ghost" onClick={() => { setSheet(sheet === "connect" ? null : "connect"); setErr(null); }}>Connect registrar</button>
          <button className="btn btn--primary" onClick={() => { setSheet(sheet === "add" ? null : "add"); setErr(null); }}>+ Add domain</button>
        </div>
      </div>

      {err ? <p className="screen-sub" style={{ color: "var(--alert)" }}>{err}</p> : null}
      {info ? <p className="screen-sub" style={{ color: "var(--good, var(--muted))" }}>{info}</p> : null}

      {sheet === "add" ? (
        <form className="card" style={{ marginBottom: "var(--s4)", display: "flex", flexDirection: "column", gap: "var(--s3)" }} onSubmit={(e) => void addDomain(e)}>
          <div className="card__head"><div className="card__title">Add domain</div></div>
          <div className="field">
            <label className="field__label" htmlFor="d-name">Domain</label>
            <input id="d-name" name="name" className="input" required placeholder="example.com" />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="d-reg">Registrar</label>
            <select id="d-reg" name="registrar" className="input" defaultValue="manual">
              <option value="manual">Manual</option>
              {REGISTRARS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="d-exp">Expires <span style={{ fontWeight: 400 }}>(optional)</span></label>
            <input id="d-exp" name="expires_at" type="date" className="input" />
          </div>
          <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: "var(--s2)" }}>
            <input type="checkbox" name="auto_renew" /> <span className="field__label" style={{ margin: 0 }}>Auto-renew</span>
          </label>
          <div style={{ display: "flex", gap: "var(--s2)" }}>
            <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? "Adding…" : "Add domain"}</button>
            <button type="button" className="btn btn--ghost" onClick={() => setSheet(null)}>Cancel</button>
          </div>
        </form>
      ) : null}

      {sheet === "connect" ? (
        <form className="card" style={{ marginBottom: "var(--s4)", display: "flex", flexDirection: "column", gap: "var(--s3)" }} onSubmit={(e) => void connectRegistrar(e)}>
          <div className="card__head"><div className="card__title">Connect registrar</div></div>
          <div className="field">
            <label className="field__label" htmlFor="c-reg">Registrar</label>
            <select id="c-reg" name="registrar" className="input" required defaultValue="">
              <option value="" disabled>Choose…</option>
              {REGISTRARS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="c-name">Account name</label>
            <input id="c-name" name="name" className="input" required placeholder="e.g. Personal GoDaddy" />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="c-key">API key</label>
            <input id="c-key" name="api_key" className="input" type="password" required autoComplete="off" />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="c-secret">API secret</label>
            <input id="c-secret" name="api_secret" className="input" type="password" required autoComplete="off" />
          </div>
          <p className="screen-sub" style={{ margin: 0 }}>Keys are sealed in your vault — never shown again or sent to the model.</p>
          <div style={{ display: "flex", gap: "var(--s2)" }}>
            <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? "Connecting…" : "Connect"}</button>
            <button type="button" className="btn btn--ghost" onClick={() => setSheet(null)}>Cancel</button>
          </div>
        </form>
      ) : null}

      {accounts.length > 0 ? (
        <div className="card" style={{ marginBottom: "var(--s4)" }}>
          <div className="card__head"><div className="card__title">Connected registrars</div></div>
          <div className="loglist">
            {accounts.map((a) => (
              <div className="logrow" key={a.id}>
                <span className="logrow__main">
                  <span className="logrow__primary">{cap(a.registrar)}</span>
                  <span className="logrow__meta">{a.name}</span>
                </span>
                <button className="btn btn--ghost" disabled={importing === a.id} onClick={() => void importDomains(a.id)}>
                  {importing === a.id ? "Importing…" : "Import"}
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="card">
        <div className="card__head">
          <div className="card__title">Domains</div>
          <span className="screen-sub" style={{ margin: 0 }}>{domains.length}</span>
        </div>
        {loading ? (
          <div className="skel" style={{ height: 120 }} />
        ) : domains.length === 0 ? (
          <p className="screen-sub" style={{ padding: "8px 0" }}>No domains yet — add one by hand, or connect a registrar and import.</p>
        ) : (
          <div className="loglist">
            {domains.map((d) => (
              <div className="logrow" key={d.id}>
                <span className="logrow__main">
                  <span className="logrow__primary">{d.name}</span>
                  <span className="logrow__meta">
                    {cap(d.registrar)}
                    {d.expires_at ? ` · expires ${new Date(d.expires_at).toLocaleDateString()}` : ""}
                    {d.auto_renew ? " · auto-renew" : ""}
                    {d.venture_id ? <> · <a href={`/p/charles-ventures?venture=${d.venture_id}`}>↳ {d.venture_name}</a></> : null}
                  </span>
                </span>
                <span className={"pill pill--" + (d.status === "active" ? "good" : "neutral")}><span className="pill__dot" />{d.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
