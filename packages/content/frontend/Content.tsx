// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

// Central content board — every content card across all ventures as a cross-venture swimlane board
// (ventures = rows, the content-workflow stage = columns), styled to the Charles content design
// (content-board.jsx SwimlaneBoard). Aggregates the per-venture boards via /api/content/board; moving
// a card writes through the boards API. Per-venture editing lives under /p/ventures/<slug> → Content.
import * as React from "react";
import Link from "next/link";

import { authFetch } from "@/lib/auth";
import { ContentCardDrawer } from "@/plugins/_shared/ContentCardDrawer";

interface Card { id: string; title: string; body: string | null; status: string; venture_id: string | null; venture_name: string; venture_slug: string | null; labels: string[]; board_id: string; source_conv: string | null }

// Canonical 6-stage content workflow (matches design content-data.js). Legacy 'review' cards map to
// distribution so nothing disappears.
const STAGES: Array<[string, string]> = [
  ["concept", "Concept"], ["assets", "Assets"], ["copy", "Copy"], ["distribution", "Distribution"], ["scheduled", "Scheduled"], ["published", "Published"],
];
const STAGE_IDS = STAGES.map((s) => s[0]);
const normStage = (s: string): string => (s === "review" ? "distribution" : STAGE_IDS.includes(s) ? s : "concept");

// Channel identity (glyph) — render a chip only for labels that are known channels.
const CHANNELS: Record<string, string> = { linkedin: "in", x: "X", bluesky: "bs", threads: "@", newsletter: "✉", youtube: "▶", shorts: "⧉", blog: "¶", pdf: "PDF", instagram: "ig", tiktok: "tt", mastodon: "m" };

function tag(name: string): string {
  return name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}

export default function Content(): React.ReactElement {
  const [cards, setCards] = React.useState<Card[] | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState<Card | null>(null);

  const load = React.useCallback(async () => {
    try {
      const r = await authFetch("/api/content/board");
      const j = (await r.json()) as { cards?: Card[] };
      setCards(j.cards ?? []); setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  const ventures = React.useMemo(() => {
    if (!cards) return [];
    const seen = new Set<string>(); const out: Card[] = [];
    for (const c of cards) { if (!seen.has(c.venture_name)) { seen.add(c.venture_name); out.push(c); } }
    return out;
  }, [cards]);

  return (
    <div className="cwrap" style={{ padding: "var(--s5)", maxWidth: 1320, margin: "0 auto" }}>
      <div className="cboard-head">
        <div>
          <h1 className="cboard-title">Content · all ventures</h1>
          <div className="cboard-sub">Cross-venture rollup · same 6-stage workflow, ventures as swimlanes. Work a piece under its venture (Content tab).</div>
        </div>
      </div>

      {err ? <p className="screen-sub" style={{ color: "var(--alert)" }}>{err}</p> : null}
      {!cards ? <p className="screen-sub">Loading…</p> : !cards.length ? (
        <p className="screen-sub">No content cards yet. Create them under a venture&apos;s Content tab.</p>
      ) : (
        <div className="swimwrap">
          {ventures.map((rep) => {
            const vc = cards.filter((c) => c.venture_name === rep.venture_name);
            return (
              <div className="swim" key={rep.venture_name}>
                <div className="swim__head">
                  <span className="swim__mk">{tag(rep.venture_name)}</span>
                  <div>
                    {rep.venture_slug
                      ? <Link className="swim__name" href={`/p/ventures/${rep.venture_slug}/content`} style={{ textDecoration: "none", color: "inherit" }} title="Open this venture's Content board">{rep.venture_name} →</Link>
                      : <span className="swim__name">{rep.venture_name}</span>}
                  </div>
                  <span className="swim__count">{vc.length} creative{vc.length === 1 ? "" : "s"}</span>
                </div>
                <div className="swim__lane">
                  {STAGES.map(([id, label]) => {
                    const cell = vc.filter((c) => normStage(c.status) === id);
                    return (
                      <div className="swim__cell" key={id}>
                        <div className="swim__cellhead">{label}</div>
                        {cell.map((c) => (
                          <button className="swimcard" key={c.id} onClick={() => setOpen(c)}>
                            <div className="swimcard__title">{c.title}</div>
                            <div className="ccard__meta">
                              {c.labels.filter((l) => CHANNELS[l]).map((l) => (
                                <span className="chchip" key={l} title={l}><span className="chchip__g">{CHANNELS[l]}</span>{l}</span>
                              ))}
                            </div>
                          </button>
                        ))}
                        {cell.length === 0 && <span style={{ fontSize: 11, color: "var(--faint)", padding: "2px" }}>·</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {open ? <ContentCardDrawer cardId={open.id} onClose={() => setOpen(null)} onChanged={load} /> : null}
    </div>
  );
}
