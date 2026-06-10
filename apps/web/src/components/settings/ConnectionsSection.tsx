// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  deleteSecret,
  fetchConnections,
  setSecret,
  type Connection,
} from "@/lib/api/secrets";

/**
 * Connections — the self-serve panel for per-user integration credentials
 * (`docs/031` Phase 3). Lists every ``user_provided`` key a plugin declares;
 * the operator pastes their own value (Stripe key, OAuth token, …) which the
 * backend seals encrypted, scoped to them. Values are **never** read back —
 * a configured key shows a "set" chip, not the secret.
 */
export function ConnectionsSection(): React.ReactElement {
  const [conns, setConns] = React.useState<Connection[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setConns(await fetchConnections());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load connections");
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const onSave = React.useCallback(
    async (key: string) => {
      const value = (drafts[key] ?? "").trim();
      if (!value) return;
      setBusy(key);
      setError(null);
      try {
        await setSecret(key, value);
        setDrafts((d) => ({ ...d, [key]: "" }));
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "failed to save");
      } finally {
        setBusy(null);
      }
    },
    [drafts, load],
  );

  const onRemove = React.useCallback(
    async (key: string) => {
      setBusy(key);
      setError(null);
      try {
        await deleteSecret(key);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "failed to remove");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  return (
    <section className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-medium text-foreground">Connections</h2>
        <p className="text-xs text-muted-foreground">
          Your own credentials for integrations — stored encrypted and scoped to
          you. They&rsquo;re never shown back; a configured key shows only a
          &ldquo;set&rdquo; chip.
        </p>
      </header>

      {error !== null ? (
        <div className="rounded-md border border-dashed border-border bg-background/60 p-3 text-xs text-red-600">
          {error}
        </div>
      ) : null}

      {conns === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : conns.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No integrations need a credential yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {conns.map((c) => (
            <li
              key={c.key}
              className="flex flex-col gap-2 rounded-md border border-border p-3"
            >
              <div className="flex items-center gap-2">
                <code className="text-xs text-foreground">{c.key}</code>
                {c.configured ? (
                  <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700">
                    set
                  </span>
                ) : (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    not set
                  </span>
                )}
              </div>
              {c.description ? (
                <p className="text-xs text-muted-foreground">{c.description}</p>
              ) : null}
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  autoComplete="off"
                  value={drafts[c.key] ?? ""}
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, [c.key]: e.target.value }))
                  }
                  disabled={busy === c.key}
                  placeholder={c.configured ? "replace value…" : "paste value…"}
                  className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                />
                <Button
                  size="sm"
                  onClick={() => void onSave(c.key)}
                  disabled={busy === c.key || !(drafts[c.key] ?? "").trim()}
                >
                  Save
                </Button>
                {c.configured ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void onRemove(c.key)}
                    disabled={busy === c.key}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
