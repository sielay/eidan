// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { authFetch } from "@/lib/auth";

// OAuth callback page (/p/finance-xero/callback) — Xero's registered redirect target. Xero sends the
// browser here with ?code & ?state after consent. This page carries the host bearer back to the
// accounts API as a PUT to finish the exchange (code → refresh token, sealed server-side), then returns
// the operator to the Connections screen. Tokens never live in the browser.
export default function Callback(): React.ReactElement {
  const [status, setStatus] = React.useState<"working" | "done" | "error">("working");
  const [message, setMessage] = React.useState("Finishing the connection…");

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    const oauthErr = params.get("error");

    if (oauthErr) {
      setStatus("error");
      setMessage(`Xero declined the connection: ${oauthErr}`);
      return;
    }
    if (!code || !state) {
      setStatus("error");
      setMessage("Missing code or state in the callback URL.");
      return;
    }

    void (async () => {
      try {
        const r = await authFetch("/api/finance-xero/accounts", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, state }),
        });
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; handle?: string; error?: string };
        if (!r.ok || !j.ok) throw new Error(j.error ?? `connection failed (${r.status})`);
        setStatus("done");
        setMessage(j.handle ? `Connected ${j.handle}. Returning…` : "Connected. Returning…");
        window.setTimeout(() => window.location.assign("/p/finance-xero"), 900);
      } catch (e) {
        setStatus("error");
        setMessage(e instanceof Error ? e.message : "Failed to finish the connection.");
      }
    })();
  }, []);

  return (
    <div className="xconn">
      <header className="xconn__head">
        <h1>Xero</h1>
      </header>
      <section className="xconn__add">
        <p className={status === "error" ? "xconn__err" : "xconn__muted"}>{message}</p>
        {status === "error" ? (
          <button className="xconn__btn" onClick={() => window.location.assign("/p/finance-xero")}>
            Back to Connections
          </button>
        ) : null}
      </section>
    </div>
  );
}
