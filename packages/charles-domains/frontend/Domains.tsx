// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { authFetch } from "@/lib/auth";

interface Domain {
  id: string;
  name: string;
  registrar: string;
  status: string;
  expires_at: string | null;
  auto_renew: boolean | null;
}

interface RegistrarAccount {
  id: string;
  registrar: string;
  name: string;
}

interface DomainsPayload {
  domains: Domain[];
}

interface RegistrarsPayload {
  accounts: RegistrarAccount[];
}

export default function Domains(): React.ReactElement {
  const [domains, setDomains] = React.useState<Domain[]>([]);
  const [accounts, setAccounts] = React.useState<RegistrarAccount[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [showAddForm, setShowAddForm] = React.useState(false);
  const [showConnectForm, setShowConnectForm] = React.useState(false);

  React.useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError("");
      try {
        const [domainsRes, registrarsRes] = await Promise.all([
          authFetch("/api/charles/domains"),
          authFetch("/api/charles/domains/registrars"),
        ]);
        if (domainsRes.ok && registrarsRes.ok) {
          const domainData = (await domainsRes.json()) as DomainsPayload;
          const registrarData = (await registrarsRes.json()) as RegistrarsPayload;
          setDomains(domainData.domains);
          setAccounts(registrarData.accounts);
        } else {
          setError("Failed to load data");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, []);

  const handleAddDomain = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = form.get("name") as string;
    const registrar = form.get("registrar") as string;
    const expiresAt = form.get("expires_at") as string;
    const autoRenew = form.get("auto_renew") === "on";

    try {
      const res = await authFetch("/api/charles/domains", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          registrar: registrar || "manual",
          expires_at: expiresAt || undefined,
          auto_renew: autoRenew || undefined,
        }),
      });
      if (res.ok) {
        setShowAddForm(false);
        const payload = await authFetch("/api/charles/domains");
        if (payload.ok) {
          const data = (await payload.json()) as DomainsPayload;
          setDomains(data.domains);
        }
      } else {
        setError("Failed to add domain");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  };

  const handleConnectRegistrar = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const registrar = form.get("registrar") as string;
    const name = form.get("name") as string;
    const apiKey = form.get("api_key") as string;
    const apiSecret = form.get("api_secret") as string;

    try {
      const res = await authFetch("/api/charles/domains/registrars", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "connect",
          registrar,
          name,
          api_key: apiKey,
          api_secret: apiSecret,
        }),
      });
      if (res.ok) {
        setShowConnectForm(false);
        const payload = await authFetch("/api/charles/domains/registrars");
        if (payload.ok) {
          const data = (await payload.json()) as RegistrarsPayload;
          setAccounts(data.accounts);
        }
      } else {
        setError("Failed to connect registrar");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  };

  const handleImport = async (accountId: string) => {
    try {
      const res = await authFetch("/api/charles/domains/registrars", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "import",
          account_id: accountId,
        }),
      });
      if (res.ok) {
        const payload = await authFetch("/api/charles/domains");
        if (payload.ok) {
          const data = (await payload.json()) as DomainsPayload;
          setDomains(data.domains);
        }
      } else {
        setError("Failed to import domains");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  };

  if (loading) return <div className="screen">Loading...</div>;

  return (
    <div className="screen">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--s4)" }}>
        <h1>Domains</h1>
        <div style={{ display: "flex", gap: "var(--s2)" }}>
          <button onClick={() => setShowAddForm(!showAddForm)} className="btn btn-primary">
            + Add Domain
          </button>
          <button onClick={() => setShowConnectForm(!showConnectForm)} className="btn btn-secondary">
            + Connect Registrar
          </button>
        </div>
      </div>

      {error && <div style={{ color: "var(--color-error)", marginBottom: "var(--s3)" }}>{error}</div>}

      {showAddForm && (
        <form onSubmit={handleAddDomain} style={{ marginBottom: "var(--s4)", padding: "var(--s3)", border: "1px solid var(--color-border)", borderRadius: "var(--radius)" }}>
          <h3>Add Domain</h3>
          <div style={{ marginBottom: "var(--s2)" }}>
            <label>
              Domain Name*
              <input type="text" name="name" required placeholder="example.com" style={{ width: "100%" }} />
            </label>
          </div>
          <div style={{ marginBottom: "var(--s2)" }}>
            <label>
              Registrar
              <select name="registrar" style={{ width: "100%" }}>
                <option value="manual">Manual</option>
                <option value="godaddy">GoDaddy</option>
                <option value="cyberfolks">Cyberfolks</option>
              </select>
            </label>
          </div>
          <div style={{ marginBottom: "var(--s2)" }}>
            <label>
              Expires At
              <input type="datetime-local" name="expires_at" style={{ width: "100%" }} />
            </label>
          </div>
          <div style={{ marginBottom: "var(--s2)" }}>
            <label>
              <input type="checkbox" name="auto_renew" /> Auto-renew
            </label>
          </div>
          <button type="submit" className="btn btn-primary">
            Add
          </button>
          <button type="button" onClick={() => setShowAddForm(false)} className="btn btn-secondary" style={{ marginLeft: "var(--s2)" }}>
            Cancel
          </button>
        </form>
      )}

      {showConnectForm && (
        <form
          onSubmit={handleConnectRegistrar}
          style={{ marginBottom: "var(--s4)", padding: "var(--s3)", border: "1px solid var(--color-border)", borderRadius: "var(--radius)" }}
        >
          <h3>Connect Registrar</h3>
          <div style={{ marginBottom: "var(--s2)" }}>
            <label>
              Registrar*
              <select name="registrar" required style={{ width: "100%" }}>
                <option value="">Select...</option>
                <option value="godaddy">GoDaddy</option>
                <option value="cyberfolks">Cyberfolks</option>
              </select>
            </label>
          </div>
          <div style={{ marginBottom: "var(--s2)" }}>
            <label>
              Account Name*
              <input type="text" name="name" required placeholder="My GoDaddy Account" style={{ width: "100%" }} />
            </label>
          </div>
          <div style={{ marginBottom: "var(--s2)" }}>
            <label>
              API Key*
              <input type="password" name="api_key" required style={{ width: "100%" }} />
            </label>
          </div>
          <div style={{ marginBottom: "var(--s2)" }}>
            <label>
              API Secret*
              <input type="password" name="api_secret" required style={{ width: "100%" }} />
            </label>
          </div>
          <button type="submit" className="btn btn-primary">
            Connect
          </button>
          <button type="button" onClick={() => setShowConnectForm(false)} className="btn btn-secondary" style={{ marginLeft: "var(--s2)" }}>
            Cancel
          </button>
        </form>
      )}

      {accounts.length > 0 && (
        <div style={{ marginBottom: "var(--s4)" }}>
          <h3>Connected Registrars</h3>
          <div style={{ display: "grid", gap: "var(--s2)" }}>
            {accounts.map((account) => (
              <div key={account.id} style={{ padding: "var(--s3)", border: "1px solid var(--color-border)", borderRadius: "var(--radius)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <strong>{account.registrar.charAt(0).toUpperCase() + account.registrar.slice(1)}</strong>
                  <p style={{ margin: "var(--s1) 0 0 0", fontSize: "0.9em" }}>{account.name}</p>
                </div>
                <button onClick={() => void handleImport(account.id)} className="btn btn-secondary">
                  Import Domains
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h3>Domains ({domains.length})</h3>
        {domains.length === 0 ? (
          <p style={{ color: "var(--color-muted)" }}>No domains registered yet</p>
        ) : (
          <div style={{ display: "grid", gap: "var(--s2)" }}>
            {domains.map((domain) => (
              <div key={domain.id} style={{ padding: "var(--s3)", border: "1px solid var(--color-border)", borderRadius: "var(--radius)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
                  <div>
                    <strong>{domain.name}</strong>
                    <div style={{ display: "flex", gap: "var(--s2)", marginTop: "var(--s1)", fontSize: "0.9em", color: "var(--color-muted)" }}>
                      <span>{domain.registrar}</span>
                      {domain.expires_at && <span>Expires: {new Date(domain.expires_at).toLocaleDateString()}</span>}
                      {domain.auto_renew && <span>✓ Auto-renew</span>}
                    </div>
                  </div>
                  <span style={{ fontSize: "0.85em", padding: "var(--s1) var(--s2)", backgroundColor: domain.status === "active" ? "var(--color-success-bg)" : "var(--color-muted-bg)", borderRadius: "var(--radius-sm)" }}>
                    {domain.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
