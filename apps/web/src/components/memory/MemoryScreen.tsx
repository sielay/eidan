// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Hash,
  Pencil,
  Pin,
  Search,
  Sparkles,
} from "lucide-react";

/**
 * Memory browser (UI_DESIGN_BRIEF §7, Core): Notes · Events · Knowledge,
 * each a calm list → detail (notes also edit).
 *
 * This is the design implementation pass with the handoff's sample
 * content. Wiring the tabs to real data — the live `GET /api/knowledge`
 * for Knowledge, and the notes/events stores once their APIs land — is
 * the follow-up; the screen shapes + states are the deliverable here.
 */

type Zone = "good" | "info" | "warn" | "alert";
type Area = "notes" | "events" | "knowledge";

interface Note {
  id: string;
  title: string;
  snippet: string;
  tags: string[];
  updated: string;
  pinned: boolean;
  body: string[];
}
interface EventItem {
  id: string;
  title: string;
  when: string;
  zone: Zone;
  status: "due" | "today" | "pending" | "done";
  note: string;
}
interface Knowledge {
  id: string;
  title: string;
  summary: string;
  body: { h: string; p: string[]; list?: string[]; code?: string };
}

const NOTES: Note[] = [
  { id: "n1", title: "Garden planting plan", snippet: "Tomatoes after last frost (~mid-May). Basil alongside…", tags: ["Home", "Seasonal"], updated: "2 days ago", pinned: true, body: ["Tomatoes go in after the last frost — around mid-May here.", "Companion planting: basil alongside tomatoes, marigolds on the border to keep pests down.", "Order seeds by end of February so the seedlings have time indoors."] },
  { id: "n2", title: "Tax deadlines 25/26", snippet: "Self-assessment 31 Jan · VAT quarterly · payment on account…", tags: ["Finance"], updated: "1 week ago", pinned: true, body: ["Self-assessment filing & balancing payment: 31 January.", "Payments on account: 31 January and 31 July.", "VAT returns: quarterly, one month + 7 days after quarter end."] },
  { id: "n3", title: "Books I want to read", snippet: "12 items · fiction & a couple on systems thinking", tags: ["Personal"], updated: "3 weeks ago", pinned: false, body: ["A running list — no pressure, just capture.", "Currently 12 items, mostly fiction with a couple on systems thinking."] },
  { id: "n4", title: "Flat handover checklist", snippet: "Meter readings, keys ×3, forward post, cancel broadband…", tags: ["Home", "Admin"], updated: "a month ago", pinned: false, body: ["Meter readings (gas, electric, water) with photos.", "Keys: 3 sets to agent.", "Forward post, cancel broadband, final bills."] },
];

const EVENTS: EventItem[] = [
  { id: "e1", title: "Renew passport", when: "in 3 weeks", zone: "warn", status: "due", note: "Photos done. Need to book a check-and-send appointment." },
  { id: "e2", title: "Call dad", when: "today", zone: "info", status: "today", note: "It's his birthday on Thursday." },
  { id: "e3", title: "Dentist check-up", when: "overdue · 5 days", zone: "alert", status: "due", note: "Reschedule — missed the last slot." },
  { id: "e4", title: "Submit VAT return", when: "in 12 days", zone: "info", status: "pending", note: "Quarter to 31 May. eidan can draft the figures." },
  { id: "e5", title: "Pay deposit · holiday", when: "in 2 days", zone: "warn", status: "pending", note: "£200 to secure the booking." },
  { id: "e6", title: "Annual review notes", when: "done · yesterday", zone: "good", status: "done", note: "Sent to manager." },
];

const TOPICS: { topic: string; items: Knowledge[] }[] = [
  { topic: "Finance", items: [
    { id: "k1", title: "How my pension is structured", summary: "Workplace + SIPP, target allocation", body: { h: "Pension structure", p: ["Two pots: a workplace scheme (auto-enrolled, employer match to 5%) and a self-invested personal pension (SIPP)."], list: ["Target allocation: 80% global equities, 20% bonds, rebalanced yearly.", "SIPP provider fee: 0.25% capped."], code: "review: every April" } },
    { id: "k2", title: "Emergency fund target", summary: "6 months of essentials, held in premium bonds", body: { h: "Emergency fund", p: ["Target is six months of essential spend, kept liquid."], list: ["Held in premium bonds + an easy-access saver.", "Top up first whenever a windfall lands."] } },
  ] },
  { topic: "Health", items: [
    { id: "k3", title: "Sleep routine that works for me", summary: "Wind-down at 22:30, no screens, magnesium", body: { h: "Sleep routine", p: ["Consistency matters more than duration for how I feel."], list: ["Wind-down starts 22:30 — lights down, no screens.", "Magnesium most nights.", "Hard cut-off on caffeine after 14:00."] } },
    { id: "k4", title: "Training split", summary: "Push / Pull / Legs, 4 days", body: { h: "Training split", p: ["Push / Pull / Legs over four days, with the 4th day floating."], list: ["Progressive overload, log every set.", "Deload every 6th week."] } },
  ] },
  { topic: "Home", items: [
    { id: "k5", title: "Boiler & heating notes", summary: "Serviced annually, pressure 1.2–1.5 bar", body: { h: "Boiler & heating", p: ["Serviced every autumn before the cold sets in."], list: ["Healthy pressure: 1.2–1.5 bar cold.", "Repressurise via the filling loop under the boiler."] } },
  ] },
];

const TABS: { id: Area; label: string }[] = [
  { id: "notes", label: "Notes" },
  { id: "events", label: "Events" },
  { id: "knowledge", label: "Knowledge" },
];

export function MemoryScreen(): React.ReactElement {
  const [area, setArea] = React.useState<Area>("notes");
  const [selected, setSelected] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [filter, setFilter] = React.useState("All");

  // Detail views own the screen; the bar's Back returns to the list.
  if (selected && area === "notes") {
    return editing ? (
      <NoteEdit id={selected} onDone={() => setEditing(false)} />
    ) : (
      <NoteDetail id={selected} onBack={() => setSelected(null)} onEdit={() => setEditing(true)} />
    );
  }
  if (selected && area === "events") {
    return <EventDetail id={selected} onBack={() => setSelected(null)} />;
  }
  if (selected && area === "knowledge") {
    return <KnowledgeDetail id={selected} onBack={() => setSelected(null)} />;
  }

  return (
    <div className="content">
      <div className="screen-head">
        <div>
          <h1 className="screen-title">Memory</h1>
          <div className="screen-sub">Notes · events · knowledge</div>
        </div>
        <button type="button" className="iconbtn" aria-label="Search memory">
          <Search className="i" aria-hidden />
        </button>
      </div>

      <div className="subtabs" role="tablist" aria-label="Memory sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            className="subtab"
            aria-selected={area === t.id}
            onClick={() => {
              setArea(t.id);
              setSelected(null);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="card card--flat" style={{ padding: "var(--s4)" }}>
        {area === "notes" ? <NotesList onSelect={setSelected} /> : null}
        {area === "events" ? (
          <EventsList filter={filter} setFilter={setFilter} onSelect={setSelected} />
        ) : null}
        {area === "knowledge" ? <KnowledgeList onSelect={setSelected} /> : null}
      </div>
    </div>
  );
}

/* ---------------- Notes ---------------- */
function NoteRow({ n, onSelect }: { n: Note; onSelect: (id: string) => void }): React.ReactElement {
  return (
    <button type="button" className="mem-row" onClick={() => onSelect(n.id)}>
      <span className="mem-row__main">
        <span className="mem-row__title">
          {n.pinned ? <Pin className="i-sm mem-pin" aria-hidden /> : null}
          {n.title}
        </span>
        <span className="mem-row__snip">{n.snippet}</span>
        <span className="mem-row__tags">
          {n.tags.map((t) => (
            <span key={t} className="memtag">{t}</span>
          ))}
          <span className="mem-row__time">· {n.updated}</span>
        </span>
      </span>
      <ChevronRight className="i-sm mem-chev" aria-hidden />
    </button>
  );
}

function NotesList({ onSelect }: { onSelect: (id: string) => void }): React.ReactElement {
  const pinned = NOTES.filter((n) => n.pinned);
  const rest = NOTES.filter((n) => !n.pinned);
  return (
    <div className="mem-list">
      <div className="mem-group">Pinned</div>
      {pinned.map((n) => <NoteRow key={n.id} n={n} onSelect={onSelect} />)}
      <div className="mem-group">All notes</div>
      {rest.map((n) => <NoteRow key={n.id} n={n} onSelect={onSelect} />)}
    </div>
  );
}

function DetailBar({
  label,
  onBack,
  children,
}: {
  label: string;
  onBack: () => void;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="mem-detail__bar">
      <button type="button" className="iconbtn mem-backbtn" onClick={onBack}>
        <ChevronLeft className="i-sm" aria-hidden />
        {label}
      </button>
      {children ? <div className="erow" style={{ gap: 8 }}>{children}</div> : null}
    </div>
  );
}

function NoteDetail({
  id,
  onBack,
  onEdit,
}: {
  id: string;
  onBack: () => void;
  onEdit: () => void;
}): React.ReactElement {
  const n = NOTES.find((x) => x.id === id) ?? NOTES[0];
  return (
    <div className="content">
      <div className="mem-detail">
        <DetailBar label="Memory" onBack={onBack}>
          <button type="button" className="iconbtn" onClick={onEdit}>
            <Pencil className="i-sm" aria-hidden />
            Edit
          </button>
          <button type="button" className="iconbtn" aria-pressed={n.pinned} aria-label="Pin note">
            <Pin className="i-sm" aria-hidden />
          </button>
        </DetailBar>
        <h1 className="mem-detail__title">{n.title}</h1>
        <div className="mem-row__tags" style={{ marginBottom: "var(--s4)" }}>
          {n.tags.map((t) => <span key={t} className="memtag">{t}</span>)}
          <span className="mem-row__time">· updated {n.updated}</span>
        </div>
        <div className="md">
          {n.body.map((p, i) => <p key={i}>{p}</p>)}
        </div>
      </div>
    </div>
  );
}

function NoteEdit({ id, onDone }: { id: string; onDone: () => void }): React.ReactElement {
  const n = NOTES.find((x) => x.id === id) ?? NOTES[0];
  return (
    <div className="content">
      <div className="mem-detail">
        <div className="mem-detail__bar">
          <button type="button" className="iconbtn mem-backbtn" onClick={onDone}>
            <ChevronLeft className="i-sm" aria-hidden />
            Cancel
          </button>
          <button type="button" className="btn btn--primary" style={{ minHeight: 38 }} onClick={onDone}>
            Save
          </button>
        </div>
        <div className="field" style={{ marginBottom: "var(--s4)" }}>
          <span className="field__label">Title</span>
          <div className="input" style={{ fontWeight: 600 }}>{n.title}</div>
        </div>
        <div className="field" style={{ marginBottom: "var(--s4)" }}>
          <span className="field__label">Note</span>
          <div className="input mem-textarea">{n.body.join("\n\n")}</div>
        </div>
        <div className="field">
          <span className="field__label">Tags</span>
          <div className="erow">
            {n.tags.map((t) => <span key={t} className="chip chip--selected">{t}</span>)}
            <span className="chip">+ Add</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Events ---------------- */
function EventsList({
  filter,
  setFilter,
  onSelect,
}: {
  filter: string;
  setFilter: (f: string) => void;
  onSelect: (id: string) => void;
}): React.ReactElement {
  const filters = ["All", "Today", "Due", "Pending"];
  const map: Record<string, EventItem["status"]> = { Today: "today", Due: "due", Pending: "pending" };
  const shown =
    filter === "All"
      ? EVENTS
      : EVENTS.filter((e) => e.status === map[filter] || (filter === "Due" && e.zone === "alert"));
  return (
    <div>
      <div className="erow" style={{ marginBottom: "var(--s4)" }}>
        {filters.map((f) => (
          <button
            key={f}
            type="button"
            className={"chip" + (filter === f ? " chip--selected" : "")}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>
      <div className="mem-list">
        {shown.map((e) => (
          <button key={e.id} type="button" className="mem-row" onClick={() => onSelect(e.id)}>
            <span className="logrow__dot" style={{ background: `var(--${e.zone})`, marginTop: 6 }} />
            <span className="mem-row__main">
              <span
                className="mem-row__title"
                style={{
                  textDecoration: e.status === "done" ? "line-through" : "none",
                  opacity: e.status === "done" ? 0.6 : 1,
                }}
              >
                {e.title}
              </span>
              <span className="mem-row__time">{e.when}</span>
            </span>
            <ChevronRight className="i-sm mem-chev" aria-hidden />
          </button>
        ))}
        {shown.length === 0 ? (
          <div className="empty" style={{ padding: "24px 0" }}>
            <div className="empty__body">Nothing {filter.toLowerCase()}.</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function EventDetail({ id, onBack }: { id: string; onBack: () => void }): React.ReactElement {
  const e = EVENTS.find((x) => x.id === id) ?? EVENTS[0];
  const zLabel: Record<Zone, string> = { alert: "Overdue", warn: "Due soon", info: "Scheduled", good: "Done" };
  return (
    <div className="content">
      <div className="mem-detail">
        <DetailBar label="Events" onBack={onBack}>
          <button type="button" className="iconbtn">
            <Pencil className="i-sm" aria-hidden />
            Edit
          </button>
        </DetailBar>
        <h1 className="mem-detail__title">{e.title}</h1>
        <div className="erow" style={{ marginBottom: "var(--s5)" }}>
          <span className={"pill pill--" + e.zone}>
            <span className="pill__dot" />
            {zLabel[e.zone]}
          </span>
          <span className="mem-row__time">{e.when}</span>
        </div>
        <div className="md">
          <p>{e.note}</p>
        </div>
        <div className="erow" style={{ marginTop: "var(--s5)" }}>
          {e.status !== "done" ? (
            <button type="button" className="btn btn--primary">
              <Check className="i-sm" aria-hidden />
              Mark done
            </button>
          ) : (
            <button type="button" className="btn btn--ghost">Reopen</button>
          )}
          <button type="button" className="btn btn--ghost">Snooze</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Knowledge ---------------- */
function KnowledgeList({ onSelect }: { onSelect: (id: string) => void }): React.ReactElement {
  return (
    <div className="mem-list">
      {TOPICS.map((grp) => (
        <div key={grp.topic}>
          <div className="mem-group">{grp.topic}</div>
          {grp.items.map((k) => (
            <button key={k.id} type="button" className="mem-row" onClick={() => onSelect(k.id)}>
              <span className="res-ic">
                <Hash className="i-sm" aria-hidden />
              </span>
              <span className="mem-row__main">
                <span className="mem-row__title">{k.title}</span>
                <span className="mem-row__snip">{k.summary}</span>
              </span>
              <ChevronRight className="i-sm mem-chev" aria-hidden />
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function KnowledgeDetail({ id, onBack }: { id: string; onBack: () => void }): React.ReactElement {
  let k: Knowledge | null = null;
  let topic = "";
  for (const g of TOPICS) {
    for (const it of g.items) {
      if (it.id === id) {
        k = it;
        topic = g.topic;
      }
    }
  }
  if (!k) {
    k = TOPICS[0].items[0];
    topic = TOPICS[0].topic;
  }
  const b = k.body;
  return (
    <div className="content">
      <div className="mem-detail">
        <div className="mem-detail__bar">
          <button type="button" className="iconbtn mem-backbtn" onClick={onBack}>
            <ChevronLeft className="i-sm" aria-hidden />
            Knowledge
          </button>
          <span className="pill pill--neutral">
            <Sparkles className="i-sm" aria-hidden />
            Learned · read-only
          </span>
        </div>
        <div className="memtag" style={{ marginBottom: "var(--s2)" }}>{topic}</div>
        <h1 className="mem-detail__title">{k.title}</h1>
        <div className="md">
          <h3>{b.h}</h3>
          {b.p.map((p, i) => <p key={i}>{p}</p>)}
          {b.list ? (
            <ul>
              {b.list.map((l, i) => <li key={i}>{l}</li>)}
            </ul>
          ) : null}
          {b.code ? <code className="md-code">{b.code}</code> : null}
        </div>
      </div>
    </div>
  );
}
