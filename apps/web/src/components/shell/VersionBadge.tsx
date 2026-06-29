// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { X } from "lucide-react";

import { authFetch } from "@/lib/auth";

type NodeVersion = { node_id: string; node_type: string | null; version: string | null; status: string };
type VersionInfo = { web: string; nodes: NodeVersion[] };

const LAYER_LABEL: Record<string, string> = {
  fly: "Fly (cloud engine)",
  pi: "Pi (kesha)",
  heroku: "Heroku",
  k8s: "Kubernetes",
  local: "Local",
};

// Lives at the bottom of the desktop rail, which itself only renders on wide screens (the rail is
// display:none on mobile) — so the indicator is wide-screen-only without any extra breakpoint guard.
export function VersionBadge(): React.ReactElement | null {
  const [info, setInfo] = React.useState<VersionInfo | null>(null);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    void authFetch("/api/version")
      .then((r) => (r.ok ? (r.json() as Promise<VersionInfo>) : null))
      .then((d) => { if (alive && d) setInfo(d); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);

  if (!info) return null;

  // Compact label = the distinct set of known versions across all layers, so drift shows at a glance
  // (e.g. "0.14.5/0.14.4" when a node lags). Nodes that haven't reported a version yet are omitted here.
  const known = [info.web, ...info.nodes.map((n) => n.version).filter((v): v is string => Boolean(v))];
  const compact = Array.from(new Set(known)).join("/") || info.web;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Deployed versions — click for per-layer detail"
        className="mt-2 w-full truncate px-3 py-1 text-left font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground"
      >
        v{compact}
      </button>
      {open ? <VersionModal info={info} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function VersionModal({ info, onClose }: { info: VersionInfo; onClose: () => void }): React.ReactElement {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const layers: Array<{ label: string; version: string | null; status: string }> = [
    { label: "Web (Vercel)", version: info.web, status: "online" },
    ...info.nodes.map((n) => ({
      label: LAYER_LABEL[n.node_type ?? ""] ?? n.node_id,
      version: n.version,
      status: n.status,
    })),
  ];

  const dot = (status: string): string =>
    status === "online" ? "bg-emerald-500" : status === "offline" ? "bg-zinc-400" : "bg-amber-500";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-[90vw] max-w-md rounded-lg border border-border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold">Deployed versions</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-3">
          <table className="w-full text-xs">
            <tbody>
              {layers.map((l, i) => (
                <tr key={i} className="border-b border-border/50 last:border-0">
                  <td className="py-2 pr-3 text-muted-foreground">{l.label}</td>
                  <td className="py-2 pr-3 font-mono">{l.version ? `v${l.version}` : "—"}</td>
                  <td className="py-2 text-right">
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${dot(l.status)}`}
                      title={l.status}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-[10px] text-muted-foreground">
            A node shows “—” until it redeploys with version reporting.
          </p>
        </div>
      </div>
    </div>
  );
}
