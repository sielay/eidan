// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { fetchConnections, setSecret, type Connection } from "@/lib/api/secrets";

const URL_KEY = "EIDAN_GLUE_MCP_URL";
const SECRET_KEY = "GLUE_MCP_SECRET";

const CAPABILITIES: Array<{ tool: string; title: string; body: string }> = [
  { tool: "glue_analytics", title: "Analytics", body: "Web metrics, retention, and per-funnel conversion — read-only." },
  { tool: "glue_funnels", title: "Funnels", body: "List, create, edit, and measure conversion funnels and their steps." },
  { tool: "glue_lists", title: "Lists", body: "Manage subscribers and topics (mailing lists / segments)." },
  { tool: "glue_campaigns", title: "Campaigns", body: "Create, schedule, and send bulk-email campaigns." },
];

export default function Setup(): React.ReactElement {
  const [conns, setConns] = React.useState<Connection[] | null>(null);
  const [url, setUrl] = React.useState("");
  const [secret, setSecret_] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ kind: "good" | "alert"; text: string } | null>(null);

  const load = React.useCallback(async () => {
    try {
      setConns(await fetchConnections());
    } catch {
      setConns([]);
    }
  }, []);
  React.useEffect(() => {
    void load();
  }, [load]);

  const urlSet = conns?.some((c) => c.key === URL_KEY && c.configured) ?? false;
  const secretSet = conns?.some((c) => c.key === SECRET_KEY && c.configured) ?? false;
  const connected = urlSet && secretSet;

  async function save() {
    if (!url.trim() && !secret.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      if (url.trim()) await setSecret(URL_KEY, url.trim());
      if (secret.trim()) await setSecret(SECRET_KEY, secret.trim());
      setUrl("");
      setSecret_("");
      await load();
      setMsg({ kind: "good", text: "Saved. Ask the agent to “list my Glue projects” to confirm." });
    } catch (e) {
      setMsg({ kind: "alert", text: e instanceof Error ? e.message : "Failed to save" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="glue-screen">
      <header className="screen-head">
        <h1 className="screen-title">Glue marketing</h1>
        <p className="screen-sub">
          Drive your Glue suite from chat — analytics, funnels, subscriber lists, and email campaigns.
          eidan talks to Glue’s MCP server; nothing is stored here.
        </p>
      </header>

      <section className="card">
        <div className="card__head">
          <span className="card__title">Connection</span>
          <span className={`pill ${connected ? "pill--good" : "pill--warn"}`}>
            <span className="pill__dot" />
            {connected ? "Connected" : "Not configured"}
          </span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="glue-url">
            MCP endpoint URL {urlSet && <span className="glue-tag">set</span>}
          </label>
          <input
            id="glue-url"
            className="input"
            type="url"
            inputMode="url"
            autoComplete="off"
            placeholder={urlSet ? "•••••• (configured — type to replace)" : "https://glue.example.com/api/mcp"}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={busy}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="glue-secret">
            MCP secret (X-MCP-Secret) {secretSet && <span className="glue-tag">set</span>}
          </label>
          <input
            id="glue-secret"
            className="input"
            type="password"
            autoComplete="new-password"
            placeholder={secretSet ? "•••••• (configured — type to replace)" : "Glue’s MCP_GLUE_SECRET"}
            value={secret}
            onChange={(e) => setSecret_(e.target.value)}
            disabled={busy}
          />
          <p className="screen-sub glue-hint">Both values are sealed in your vault and never shown back.</p>
        </div>

        {msg && <p className={`glue-msg glue-msg--${msg.kind}`}>{msg.text}</p>}

        <button
          className="btn btn--primary btn--block"
          onClick={() => void save()}
          disabled={busy || (!url.trim() && !secret.trim())}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </section>

      <section className="card">
        <div className="card__head">
          <span className="card__title">What you can ask for</span>
        </div>
        <div className="glue-caps">
          {CAPABILITIES.map((c) => (
            <div key={c.tool} className="glue-cap">
              <div className="glue-cap__title">{c.title}</div>
              <div className="glue-cap__body">{c.body}</div>
              <code className="glue-cap__tool">{c.tool}</code>
            </div>
          ))}
        </div>
        <p className="screen-sub glue-hint">
          Writes (creating funnels, sending campaigns) are gated by each Glue project’s autonomy level —
          raise it in Glue to allow them.
        </p>
      </section>
    </div>
  );
}
