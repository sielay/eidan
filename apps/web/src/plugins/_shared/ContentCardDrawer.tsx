// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

// Content-workflow card drawer — the priority screen, styled to the Charles design (content-drawer.jsx;
// classes from the content plugin's content.css). Header + stage-gate strip + Chat/Assets/Copy tabs +
// a Schedule/Fork/Refs/Activity rail. Wired to /api/content/card (detail + advance/approve/save copy).
// Shared by the central board (/p/content) and the venture Content tab. The heavy execution (Glue/
// LinkedIn posting on publish) is modelled, not yet fired.
import * as React from "react";

import { authFetch } from "@/lib/auth";

const STAGES: Array<[string, string]> = [
  ["concept", "Concept"], ["assets", "Assets"], ["copy", "Copy"], ["distribution", "Distribution"], ["scheduled", "Scheduled"], ["published", "Published"],
];
const STAGE_IDS = STAGES.map((s) => s[0]);
const norm = (s: string): string => (s === "review" ? "distribution" : STAGE_IDS.includes(s) ? s : "concept");
const GATES: Record<string, { label: string; verb: string; auto?: boolean }> = {
  concept: { label: "Idea settled", verb: "Freezes the concept · opens the asset workspace" },
  assets: { label: "Assets settled", verb: "Locks approved assets · opens per-channel copy" },
  copy: { label: "Copy approved", verb: "Freezes copy · wires channels + resources" },
  distribution: { label: "Schedule", verb: "Pick a time · card freezes until it fires" },
  scheduled: { label: "Runs at time", verb: "System executes automatically", auto: true },
};
const CHANNELS: Record<string, string> = { linkedin: "in", x: "X", bluesky: "bs", threads: "@", newsletter: "✉", youtube: "▶", shorts: "⧉", blog: "¶", pdf: "PDF", instagram: "ig", tiktok: "tt", mastodon: "m" };

interface Filter { product?: string; buyer_outcome?: string; moves_closer?: boolean; cta?: string }
const CTAS: Array<[string, string]> = [["follow", "Follow"], ["comment", "Comment"], ["dm", "DM"], ["link", "Link"]];
function filterPasses(f: Filter | null | undefined): boolean {
  return !!f && !!f.product?.trim() && !!f.buyer_outcome?.trim() && f.moves_closer === true && !!f.cta && CTAS.some(([id]) => id === f.cta);
}

interface Asset { id: string; ref_id: string; ref_kind: string; approval_state: string; metadata: { name?: string } }
interface Copy { channel: string; body: string | null; state: string }
interface Ref { ref_kind: string; ref_id: string | null; ref_label: string | null }
interface Act { kind: string; body: string | null; created_at: string }
interface Detail {
  card: { id: string; title: string; body: string | null; status: string; conversation_id: string | null; parent_card_id: string | null; publish_at: string | null; channels: string[]; venture_id: string | null };
  filter: Filter | null; assets: Asset[]; copy: Copy[]; schedule: { publish_at: string | null; frozen_plan: unknown[]; execution_status: string } | null; refs: Ref[]; activity: Act[];
}

function relTime(s: string): string {
  const dm = Date.now() - new Date(s).getTime(), m = Math.floor(dm / 60000), h = Math.floor(dm / 3600000), dd = Math.floor(dm / 86400000);
  if (m < 1) return "just now"; if (m < 60) return `${m}m ago`; if (h < 24) return `${h}h ago`; if (dd < 7) return `${dd}d ago`;
  return new Date(s).toLocaleDateString();
}

export function ContentCardDrawer({ cardId, onClose, onChanged }: { cardId: string; onClose: () => void; onChanged?: () => void }): React.ReactElement {
  const [d, setD] = React.useState<Detail | null>(null);
  const [tab, setTab] = React.useState<"chat" | "assets" | "copy">("chat");
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try { const r = await authFetch(`/api/content/card?id=${encodeURIComponent(cardId)}`); setD((await r.json()) as Detail); } catch { /* ignore */ }
  }, [cardId]);
  React.useEffect(() => { void load(); }, [load]);

  const act = React.useCallback(async (payload: Record<string, unknown>) => {
    setBusy(true);
    try { await authFetch("/api/content/card", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: cardId, ...payload }) }); await load(); onChanged?.(); }
    finally { setBusy(false); }
  }, [cardId, load, onChanged]);

  if (!d) return <div className="drawer-scrim" onClick={onClose}><div className="drawer" onClick={(e) => e.stopPropagation()}><p className="screen-sub" style={{ padding: "var(--s5)" }}>Loading…</p></div></div>;

  const stage = norm(d.card.status);
  const now = STAGE_IDS.indexOf(stage);
  const gate = GATES[stage];
  const chList = (d.card.channels.length ? d.card.channels : Array.from(new Set(d.copy.map((c) => c.channel)))).filter(Boolean);
  const imgs = d.assets.filter((a) => a.ref_kind === "image" || a.ref_kind === "artifact");
  const files = d.assets.filter((a) => a.ref_kind !== "image" && a.ref_kind !== "artifact");

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="dwr-head">
          <div className="dwr-head__top">
            <h2 className="dwr-title">{d.card.title}</h2>
            <button className="btn btn--ghost" onClick={onClose}>Close</button>
          </div>
          <div className="dwr-head__meta">
            <span>Stage: <b style={{ color: "var(--text)" }}>{STAGES[now]?.[1]}</b></span>
            {d.card.channels.filter((c) => CHANNELS[c]).map((c) => <span className="chchip" key={c}><span className="chchip__g">{CHANNELS[c]}</span>{c}</span>)}
          </div>
        </div>

        <div className="gatestrip">
          <div className="gatetrack">
            {STAGES.map(([id, label], i) => (
              <React.Fragment key={id}>
                {i > 0 && <span className="gatestep__bar" />}
                <span className={"gatestep " + (i < now ? "gatestep--done" : i === now ? "gatestep--now" : "")}>
                  <span className="gatestep__dot">{i < now ? "✓" : i + 1}</span>
                  <span className="gatestep__label">{label}</span>
                </span>
              </React.Fragment>
            ))}
          </div>
          <div className="gatecta">
            {gate && !gate.auto && (
              <div className="gategate">
                <button className="btn btn--primary" style={{ minHeight: 40 }} disabled={busy || (stage === "copy" && !filterPasses(d.filter))} onClick={() => void act({ action: "advance" })}>{gate.label} →</button>
                <span className="gategate__verb">{stage === "copy" && !filterPasses(d.filter) ? "Pass the Content Filter (right) to distribute" : gate.verb}</span>
              </div>
            )}
            {gate && gate.auto && <span className="pill pill--info"><span className="pill__dot" />Frozen · runs at time</span>}
            {!gate && <span className="pill pill--good"><span className="pill__dot" />Published</span>}
          </div>
        </div>

        <div className="dwr-body">
          <div className="dwr-main">
            <div className="dwr-tabs" role="tablist">
              {([["chat", "Chat"], ["assets", "Assets"], ["copy", "Copy"]] as Array<["chat" | "assets" | "copy", string]>).map(([id, label]) => (
                <button key={id} className="dwr-tab" aria-selected={tab === id} onClick={() => setTab(id)}>
                  {label}{id === "assets" && d.assets.length ? <span className="dwr-tab__count">{d.assets.length}</span> : null}{id === "copy" && chList.length ? <span className="dwr-tab__count">{chList.length}</span> : null}
                </button>
              ))}
            </div>
            <div className="dwr-tabbody">
              {tab === "chat" && (
                <div>
                  <div className="chatbind">🔗 This conversation is linked to the card — assets &amp; drafts save here</div>
                  {d.card.conversation_id
                    ? <a className="btn btn--primary" href={`/c/${d.card.conversation_id}`} style={{ textDecoration: "none", marginTop: "var(--s3)", display: "inline-block" }}>Open the linked chat →</a>
                    : <p className="screen-sub" style={{ marginTop: "var(--s3)" }}>No chat linked yet — work the concept in a chat and link it to seed this card.</p>}
                  {d.card.body ? <p style={{ whiteSpace: "pre-wrap", fontSize: "var(--fs-14)", lineHeight: 1.55, marginTop: "var(--s4)" }}>{d.card.body}</p> : null}
                </div>
              )}
              {tab === "assets" && (
                d.assets.length === 0 ? (
                  <div className="empty-assets">
                    <div className="empty__title">No assets yet</div>
                    <div className="empty__body">Ask the agent to generate images, or drop files from your desktop. Everything you add saves against this card.</div>
                  </div>
                ) : (
                  <div>
                    {imgs.length > 0 && (
                      <div className="asset-sec">
                        <div className="asset-sec__head"><span className="asset-sec__title">Generated images</span><span className="asset-sec__meta">{imgs.filter((a) => a.approval_state === "pending").length} awaiting approval</span></div>
                        <div className="asset-grid">
                          {imgs.map((a) => (
                            <div className={"asset" + (a.approval_state === "pending" ? " asset--pending" : "")} key={a.id}>
                              <div className="asset__prev">
                                <span className="asset__prevlabel">{a.approval_state === "approved" ? "approved" : a.approval_state === "rejected" ? "rejected" : "generated"}</span>
                                {a.approval_state === "pending" && (
                                  <div className="asset__approve">
                                    <button className="abtn abtn--reject" disabled={busy} onClick={() => void act({ action: "reject_asset", asset_id: a.id })}>Reject</button>
                                    <button className="abtn abtn--approve" disabled={busy} onClick={() => void act({ action: "approve_asset", asset_id: a.id })}>Approve</button>
                                  </div>
                                )}
                              </div>
                              <div className="asset__foot"><span className="asset__name">{a.metadata?.name || a.ref_id.slice(0, 12)}</span></div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {files.length > 0 && (
                      <div className="asset-sec">
                        <div className="asset-sec__head"><span className="asset-sec__title">Files &amp; PDFs</span></div>
                        {files.map((a) => <div className="filerow" key={a.id}><div className="filerow__main"><div className="filerow__name">{a.metadata?.name || a.ref_id}</div><div className="filerow__meta">{a.ref_kind}</div></div></div>)}
                      </div>
                    )}
                  </div>
                )
              )}
              {tab === "copy" && <CopyEditor cardId={cardId} channels={chList} copy={d.copy} onSaved={load} />}
            </div>
          </div>

          <div className="dwr-rail">
            <ContentFilterSection cardId={cardId} filter={d.filter} onSaved={load} />
            <div className="dwr-railsec">
              <div className="dwr-railsec__tag">⏱ Schedule</div>
              {d.schedule?.publish_at
                ? <div className="schedcard"><div style={{ fontWeight: 600 }}>{new Date(d.schedule.publish_at).toLocaleString()}</div><div className="screen-sub" style={{ marginTop: 4 }}>{d.schedule.execution_status}</div></div>
                : <div className="schedcard"><div className="screen-sub" style={{ margin: 0 }}>Not scheduled. Reach the Distribution gate, then pick when it publishes.</div></div>}
            </div>
            <div className="dwr-railsec">
              <div className="dwr-railsec__tag">🜂 Fork &amp; sub-cards</div>
              <button className="btn btn--ghost" style={{ width: "100%", justifyContent: "center" }} disabled title="Coming soon">Fork to…</button>
            </div>
            {d.refs.length > 0 && (
              <div className="dwr-railsec">
                <div className="dwr-railsec__tag">🔗 Linked resources</div>
                {d.refs.map((r, i) => <div className="filerow" key={i} style={{ padding: "var(--s2) var(--s3)" }}><div className="filerow__main"><div className="filerow__name" style={{ fontSize: "var(--fs-13)" }}>{r.ref_label || r.ref_id}</div><div className="filerow__meta" style={{ fontSize: 11 }}>{r.ref_kind}</div></div></div>)}
              </div>
            )}
            <div className="dwr-railsec">
              <div className="dwr-railsec__tag">⏱ Activity</div>
              {d.activity.length === 0 ? <p className="screen-sub">No activity yet.</p> : d.activity.map((a, i) => (
                <div className="activityrow" key={i}><span className="activityrow__dot" /><div>{a.body || a.kind}<div style={{ fontSize: 11, color: "var(--faint)", fontFamily: "var(--font-num)" }}>{relTime(a.created_at)}</div></div></div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// The Content Filter — a workflow gate. A card can't leave Copy for Distribution until all three
// questions pass and exactly one CTA is picked. Saved to the card; the gate reads it server-side too.
function ContentFilterSection({ cardId, filter, onSaved }: { cardId: string; filter: Filter | null; onSaved: () => void }): React.ReactElement {
  const [f, setF] = React.useState<Filter>(filter ?? {});
  React.useEffect(() => { setF(filter ?? {}); }, [filter]);
  const pass = filterPasses(f);
  const save = async (next: Filter) => {
    setF(next);
    try { await authFetch("/api/content/card", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: cardId, action: "save_filter", filter: next }) }); onSaved(); } catch { /* ignore */ }
  };
  const ta: React.CSSProperties = { width: "100%", boxSizing: "border-box", minHeight: 50, border: "1px solid var(--border)", borderRadius: "var(--r-sm)", background: "var(--surface)", color: "var(--text)", font: "inherit", padding: "var(--s2)", resize: "vertical", fontSize: "var(--fs-13)", marginTop: 4 };
  return (
    <div className="dwr-railsec" style={{ border: `1px solid ${pass ? "var(--good)" : "var(--warn)"}`, borderRadius: "var(--r-md)", padding: "var(--s3)", marginBottom: "var(--s4)" }}>
      <div className="dwr-railsec__tag" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Content filter</span>
        <span className={"pill pill--" + (pass ? "good" : "warn")} style={{ height: 20 }}><span className="pill__dot" />{pass ? "Passes" : "Incomplete"}</span>
      </div>
      <label className="field__label">1 · Product/outcome this post moves toward</label>
      <textarea style={ta} value={f.product || ""} placeholder="Name it explicitly — not &quot;awareness&quot;" onChange={(e) => setF({ ...f, product: e.target.value })} onBlur={() => void save(f)} />
      <label className="field__label" style={{ marginTop: 8 }}>2 · Outcome the reader wants</label>
      <textarea style={ta} value={f.buyer_outcome || ""} placeholder="Their goal, not yours" onChange={(e) => setF({ ...f, buyer_outcome: e.target.value })} onBlur={() => void save(f)} />
      <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, fontSize: "var(--fs-13)" }}>
        <input type="checkbox" checked={f.moves_closer === true} onChange={(e) => void save({ ...f, moves_closer: e.target.checked })} />
        3 · Moves them one concrete step closer
      </label>
      <label className="field__label" style={{ marginTop: 10 }}>One CTA (never zero, never two)</label>
      <div className="row" style={{ gap: 6, marginTop: 4 }}>
        {CTAS.map(([id, label]) => (
          <button key={id} className={"chip" + (f.cta === id ? " chip--selected" : "")} onClick={() => void save({ ...f, cta: f.cta === id ? undefined : id })}>{label}</button>
        ))}
      </div>
    </div>
  );
}

function CopyEditor({ cardId, channels, copy, onSaved }: { cardId: string; channels: string[]; copy: Copy[]; onSaved: () => void }): React.ReactElement {
  const byCh = new Map(copy.map((c) => [c.channel, c]));
  const list = channels.length ? channels : copy.map((c) => c.channel);
  if (!list.length) return <div className="empty-assets"><div className="empty__title">No channels yet</div><div className="empty__body">Set the card&apos;s channels, then draft a doc per channel here.</div></div>;
  return (
    <div>
      <p className="screen-sub" style={{ marginBottom: 16 }}>One editable doc per channel — saved against this card.</p>
      {list.map((ch) => <ChannelCopy key={ch} cardId={cardId} channel={ch} initial={byCh.get(ch)?.body ?? ""} state={byCh.get(ch)?.state ?? "empty"} onSaved={onSaved} />)}
    </div>
  );
}

function ChannelCopy({ cardId, channel, initial, state, onSaved }: { cardId: string; channel: string; initial: string; state: string; onSaved: () => void }): React.ReactElement {
  const [text, setText] = React.useState(initial);
  const [saved, setSaved] = React.useState<string | null>(null);
  const stateMap: Record<string, [string, string]> = { ready: ["good", "Ready"], draft: ["warn", "Draft"], empty: ["neutral", "Empty"] };
  const [zone, label] = stateMap[state] ?? stateMap.empty;
  const save = async () => {
    if (text === initial) return;
    try { await authFetch("/api/content/card", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: cardId, action: "save_copy", channel, body: text }) }); setSaved("Saved"); onSaved(); setTimeout(() => setSaved(null), 1500); } catch { setSaved("Error"); }
  };
  return (
    <div className="copyvar">
      <div className="copyvar__head">
        <span className="chchip"><span className="chchip__g">{CHANNELS[channel] || channel[0]}</span>{channel}</span>
        <span className={"pill pill--" + zone} style={{ height: 22 }}><span className="pill__dot" />{label}</span>
      </div>
      <div className="copyvar__body">
        <textarea value={text} placeholder={`Draft the ${channel} copy…`} onChange={(e) => setText(e.target.value)} onBlur={() => void save()}
          style={{ width: "100%", minHeight: 90, boxSizing: "border-box", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", background: "var(--surface)", color: "var(--text)", font: "inherit", padding: "var(--s2)", resize: "vertical" }} />
      </div>
      <div className="copyvar__toolbar"><span style={{ marginLeft: "auto", fontSize: 11, color: "var(--faint)", fontFamily: "var(--font-num)" }}>{saved || "markdown · saved to card"}</span></div>
    </div>
  );
}
