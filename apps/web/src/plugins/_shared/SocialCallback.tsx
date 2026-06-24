// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

// Shared OAuth callback page for the social plugins — the registered redirect target. The platform
// sends the browser here with ?code & ?state after consent; this page carries the host bearer back to
// the accounts API as a PUT to finish the exchange (code → tokens, sealed server-side), then returns
// to the plugin's Connections screen. Tokens never live in the browser. Each plugin's
// frontend/Callback.tsx is a 3-line wrapper passing its `name`.
import * as React from "react";

import { authFetch } from "@/lib/auth";

export interface SocialCallbackProps {
  name: string; // 'social-x'
  title: string;
}

export default function SocialCallback(props: SocialCallbackProps): React.ReactElement {
  const apiBase = `/api/${props.name}/accounts`;
  const basePath = `/p/${props.name}`;
  const [status, setStatus] = React.useState<"working" | "done" | "error">("working");
  const [message, setMessage] = React.useState("Finishing the connection…");

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    const oauthErr = params.get("error") ?? params.get("error_description");

    if (oauthErr) {
      setStatus("error");
      setMessage(`The provider declined the connection: ${oauthErr}`);
      return;
    }
    if (!code || !state) {
      setStatus("error");
      setMessage("Missing code or state in the callback URL.");
      return;
    }

    void (async () => {
      try {
        const r = await authFetch(apiBase, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, state }),
        });
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; handle?: string; error?: string };
        if (!r.ok || !j.ok) throw new Error(j.error ?? `connection failed (${r.status})`);
        setStatus("done");
        setMessage(j.handle ? `Connected ${j.handle}. Returning…` : "Connected. Returning…");
        window.setTimeout(() => window.location.assign(basePath), 900);
      } catch (e) {
        setStatus("error");
        setMessage(e instanceof Error ? e.message : "Failed to finish the connection.");
      }
    })();
  }, [apiBase, basePath]);

  return (
    <div className="sconn">
      <header className="sconn__head">
        <h1>{props.title}</h1>
      </header>
      <section className="sconn__add">
        <p className={status === "error" ? "sconn__err" : "sconn__muted"}>{message}</p>
        {status === "error" ? (
          <button className="sconn__btn" onClick={() => window.location.assign(basePath)}>
            Back to Connections
          </button>
        ) : null}
      </section>
    </div>
  );
}
