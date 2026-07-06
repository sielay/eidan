// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

// Central content board — every content card across all ventures in one cross-venture kanban:
// VENTURES are swimlanes (rows), the content-workflow STAGE is the column. Aggregates the per-venture
// "Campaigns" boards (/api/content/board); moving a card writes through the boards API. Per-venture
// editing (brand kit + the venture's own board) still lives under /p/ventures/<slug> → Content.
import * as React from "react";
import Link from "next/link";

import { authFetch } from "@/lib/auth";

interface Card { id: string; title: string; body: string | null; status: string; venture_id: string | null; venture_name: string; venture_slug: string | null; labels: string[]; board_id: string; source_conv: string | null }

const LANES: Array<[string, string]> = [["concept", "Concept"], ["assets", "Assets"], ["copy", "Copy"], ["review", "Review"], ["published", "Published"]];
const ORDER = LANES.map((l) => l[0]);

const S = {
  col: { flex: "1 1 0", minWidth: 150, background: "var(--surface-2, rgba(120,120,140,.06))", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: "var(--s2)", display: "flex", flexDirection: "column" as const, gap: "var(--s2)" },
  card: { background: "var(--bg, #fff)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: "var(--s2)", cursor: "pointer", display: "flex", flexDirection: "column" as const, gap: 4 },
  chip: { fontSize: "var(--fs-12)", color: "var(--muted)", border: "1px solid var(--border)", borderRadius: 999, padding: "0 6px" },
  btn: { background: "none", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", cursor: "pointer", color: "var(--muted)", padding: "0 6px", font: "inherit" },
  drawerScrim: { position: "fixed" as const, inset: 0, background: "rgba(0,0,0,.35)", display: "flex", justifyContent: "flex-end", zIndex: 50 },
  drawer: { width: "min(480px, 100%)", height: "100%", overflowY: "auto" as const, background: "var(--bg, #fff)", borderLeft: "1px solid var(--border)", padding: "var(--s4)", display: "flex", flexDirection: "column" as const, gap: "var(--s3)" },
};

export default function Content(): React.ReactElement {
  const [cards, setCards] = React.useState<Card[] | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState<Card | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const r = await authFetch("/api/content/board");
      const j = (await r.json()) as { cards?: Card[] };
      setCards(j.cards ?? []); setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  const move = React.useCallback(async (card: Card, dir: -1 | 1) => {
    const next = ORDER[ORDER.indexOf(card.status) + dir];
    if (!next) return;
    setBusy(card.id);
    setCards((xs) => xs?.map((x) => (x.id === card.id ? { ...x, status: next } : x)) ?? xs);
    try {
      await authFetch("/api/boards/cards", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: card.id, status: next }) });
    } catch { void load(); } finally { setBusy(null); }
  }, [load]);

  const ventures = React.useMemo(() => {
    if (!cards) return [];
    const seen = new Set<string>(); const out: string[] = [];
    for (const c of cards) { if (!seen.has(c.venture_name)) { seen.add(c.venture_name); out.push(c.venture_name); } }
    return out;
  }, [cards]);

  return (
    <div style={{ padding: "var(--s5)", maxWidth: 1400, margin: "0 auto" }}>
      <h2 style={{ fontSize: "var(--fs-20)", margin: 0 }}>Content</h2>
      <p className="screen-sub" style={{ marginTop: 0, color: "var(--muted)" }}>
        Every venture&apos;s content in one board — ventures are swimlanes, the workflow stage is the column.
        Set brand voice and work a piece under its venture (<code>/p/ventures/&lt;slug&gt;</code> → Content).
      </p>

      {err ? <p className="screen-sub" style={{ color: "var(--alert)" }}>{err}</p> : null}
      {!cards ? <p className="screen-sub">Loading…</p> : !cards.length ? (
        <p className="screen-sub">No content cards yet. Create them under a venture&apos;s Content tab.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s4)", marginTop: "var(--s4)" }}>
          {/* column headers */}
          <div style={{ display: "flex", gap: "var(--s2)", paddingLeft: 160 }}>
            {LANES.map(([id, lbl]) => <div key={id} style={{ flex: "1 1 0", minWidth: 150, fontSize: "var(--fs-13)", fontWeight: 600, color: "var(--muted)" }}>{lbl}</div>)}
          </div>
          {ventures.map((vn) => {
            const vc = cards.filter((c) => c.venture_name === vn);
            return (
              <div key={vn} style={{ display: "flex", gap: "var(--s2)", alignItems: "stretch" }}>
                <div style={{ width: 152, flexShrink: 0, fontWeight: 600, fontSize: "var(--fs-14)", display: "flex", alignItems: "center", gap: 6 }}>
                  {vc[0]?.venture_slug ? (
                    <Link href={`/p/ventures/${vc[0].venture_slug}/content`} style={{ color: "var(--accent-link, var(--accent))", textDecoration: "none" }} title="Open this venture's Content board">{vn} →</Link>
                  ) : vn}
                  <span className="num" style={{ color: "var(--muted)", fontWeight: 400 }}>{vc.length}</span>
                </div>
                {LANES.map(([status]) => {
                  const lane = vc.filter((c) => c.status === status);
                  const idx = ORDER.indexOf(status);
                  return (
                    <div key={status} style={S.col}>
                      {lane.length === 0 ? <span className="screen-sub" style={{ margin: 0, opacity: .5 }}>—</span> : lane.map((c) => (
                        <div key={c.id} style={S.card} onClick={() => setOpen(c)}>
                          <span style={{ fontSize: "var(--fs-13)", lineHeight: 1.3 }}>{c.title}</span>
                          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                            {c.labels.map((l) => <span key={l} style={S.chip}>{l}</span>)}
                            <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                              <button style={S.btn} disabled={busy === c.id || idx === 0} title="Move left" onClick={(e) => { e.stopPropagation(); void move(c, -1); }}>←</button>
                              <button style={S.btn} disabled={busy === c.id || idx === ORDER.length - 1} title="Move right" onClick={(e) => { e.stopPropagation(); void move(c, 1); }}>→</button>
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {open ? (
        <div style={S.drawerScrim} onClick={() => setOpen(null)}>
          <div style={S.drawer} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--s2)" }}>
              <h3 style={{ margin: 0, fontSize: "var(--fs-17)" }}>{open.title}</h3>
              <button style={S.btn} onClick={() => setOpen(null)}>✕</button>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <span style={S.chip}>{open.venture_name}</span>
              <span style={S.chip}>{open.status}</span>
              {open.labels.map((l) => <span key={l} style={S.chip}>{l}</span>)}
            </div>
            <div style={{ display: "flex", gap: "var(--s2)", flexWrap: "wrap" }}>
              {open.venture_slug ? (
                <Link href={`/p/ventures/${open.venture_slug}/content`} className="btn btn--primary" style={{ textDecoration: "none", padding: "var(--s2) var(--s3)", borderRadius: "var(--r-sm)" }}>
                  Work on it in {open.venture_name} →
                </Link>
              ) : null}
              {open.source_conv ? (
                <Link href={`/c/${open.source_conv}`} className="btn btn--ghost" style={{ textDecoration: "none", padding: "var(--s2) var(--s3)", borderRadius: "var(--r-sm)", border: "1px solid var(--border)" }}>
                  Source chat →
                </Link>
              ) : null}
            </div>
            <p style={{ whiteSpace: "pre-wrap", fontSize: "var(--fs-14)", lineHeight: 1.5, margin: 0 }}>{open.body}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
