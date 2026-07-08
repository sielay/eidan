// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";
import * as React from "react";

import { authFetch } from "@/lib/auth";

// Storage — where uploaded files land. Offload sends bytes to object storage (S3) instead of the
// Postgres DB; direct uploads let the browser PUT straight to the bucket (needed for video-sized
// files). Backed by /api/fs/settings (eidan.kv settings/fs_upload); the engine reads the same row.
// S3 credentials themselves live in Connections above.
const OFFLOAD_OPTS: Array<{ v: "auto" | "always" | "never"; label: string; help: string }> = [
  { v: "auto", label: "Auto (recommended)", help: "Large files (≥512 KB) go to object storage; small ones stay in the database." },
  { v: "always", label: "Always offload", help: "Every upload goes to object storage. Keeps the database lean." },
  { v: "never", label: "Keep in database", help: "Never offload — all uploads stored as Postgres bytea. No S3 needed." },
];

export function StorageSection(): React.ReactElement {
  const [offload, setOffload] = React.useState<"auto" | "always" | "never">("auto");
  const [direct, setDirect] = React.useState<boolean | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    void (async () => {
      try {
        const r = await authFetch("/api/fs/settings");
        const j = (await r.json()) as { offload?: "auto" | "always" | "never"; direct?: boolean | null };
        setOffload(j.offload ?? "auto");
        setDirect(j.direct ?? null);
      } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
      finally { setLoaded(true); }
    })();
  }, []);

  const save = React.useCallback(async (next: { offload?: "auto" | "always" | "never"; direct?: boolean | null }) => {
    const body = { offload, direct, ...next };
    setOffload(body.offload as "auto" | "always" | "never");
    setDirect(body.direct ?? null);
    setSaving(true); setErr(null);
    try {
      const r = await authFetch("/api/fs/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }, [offload, direct]);

  return (
    <section className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-medium text-foreground">Storage {saving ? <span className="text-[11px] font-normal text-muted-foreground">saving…</span> : null}</h2>
        <p className="text-xs text-muted-foreground">Where uploaded files (logos, banners, images, video) are stored. S3 credentials are set under Connections.</p>
      </header>
      {err ? <div className="rounded-md border border-dashed border-border bg-background/60 p-3 text-xs text-red-600">{err}</div> : null}
      {!loaded ? <p className="text-xs text-muted-foreground">Loading…</p> : (
        <>
          <div className="flex flex-col gap-2">
            {OFFLOAD_OPTS.map((o) => (
              <label key={o.v} className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-3 text-xs">
                <input type="radio" name="offload" className="mt-0.5" checked={offload === o.v} onChange={() => void save({ offload: o.v })} />
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium text-foreground">{o.label}</span>
                  <span className="text-muted-foreground">{o.help}</span>
                </span>
              </label>
            ))}
          </div>
          <label className={"flex items-start gap-2 rounded-md border border-border p-3 text-xs " + (offload === "never" ? "opacity-50" : "cursor-pointer")}>
            <input type="checkbox" className="mt-0.5" disabled={offload === "never"} checked={direct === true} onChange={(e) => void save({ direct: e.target.checked })} />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium text-foreground">Direct browser uploads</span>
              <span className="text-muted-foreground">Upload straight to the bucket (bypasses the ~4.5 MB serverless limit — required for video). Needs the bucket CORS to allow this site. Off means uploads are proxied through the server.</span>
            </span>
          </label>
        </>
      )}
    </section>
  );
}
