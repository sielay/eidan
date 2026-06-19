// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { authFetch } from "@/lib/auth";

// OAuth callback page (/p/google/callback) — Google's registered redirect target. Google sends the
// browser here with ?code & ?state after consent. This page carries the host bearer back to the
// accounts API as a PUT to finish the exchange (code → refresh token, sealed server-side), then
// returns the operator to the Connections screen. Tokens never live in the browser.
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
      setMessage(`Google declined the connection: ${oauthErr}`);
      return;
    }
    if (!code || !state) {
      setStatus("error");
      setMessage("Missing code or state in the callback URL.");
      return;
    }

    void (async () => {
      try {
        // Finish entirely server-side: the API reads the client sealed in the vault (under this
        // pending account's key) and exchanges the code — the secret never touches the browser.
        const r = await authFetch("/api/google/accounts", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, state }),
        });
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; email?: string; error?: string };
        if (!r.ok || !j.ok) throw new Error(j.error ?? `connection failed (${r.status})`);
        setStatus("done");
        setMessage(j.email ? `Connected ${j.email}. Returning…` : "Connected. Returning…");
        window.setTimeout(() => window.location.assign("/p/google"), 900);
      } catch (e) {
        setStatus("error");
        setMessage(e instanceof Error ? e.message : "Failed to finish the connection.");
      }
    })();
  }, []);

  return (
    <div className="gconn">
      <header className="gconn__head">
        <h1>Google</h1>
      </header>
      <section className="gconn__add">
        <p className={status === "error" ? "gconn__err" : "gconn__muted"}>{message}</p>
        {status === "error" ? (
          <button className="gconn__btn" onClick={() => window.location.assign("/p/google")}>
            Back to Connections
          </button>
        ) : null}
      </section>
    </div>
  );
}
