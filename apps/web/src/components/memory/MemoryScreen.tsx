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

import { authFetch } from "@/lib/auth";

/**
 * Memory browser (UI_DESIGN_BRIEF §7, Core): Notes · Events · Knowledge,
 * each a calm list → detail (notes also edit).
 *
 * Wired to real data: Notes ← `GET /api/notes` (eidan.notes), Events ←
 * `GET /api/events` (eidan.events), Knowledge ← `GET /api/knowledge`
 * (eidan.knowledge) grouped by skill. The list→detail design and states
 * are unchanged; only the data source moved from sample content to the DB.
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

/* ---------------- Data (live) ---------------- */
interface MemData {
  notes: Note[];
  events: EventItem[];
  topics: { topic: string; items: Knowledge[] }[];
}
const MemoryContext = React.createContext<MemData>({ notes: [], events: [], topics: [] });
function useMem(): MemData {
  return React.useContext(MemoryContext);
}

interface KRow {
  id: string;
  title: string | null;
  skill: string | null;
  summary: string;
}

async function loadMemory(): Promise<MemData> {
  const [nRes, eRes, kRes] = await Promise.all([
    authFetch("/api/notes"),
    authFetch("/api/events"),
    authFetch("/api/knowledge"),
  ]);
  const notes = nRes.ok ? ((await nRes.json()) as { notes: Note[] }).notes : [];
  const events = eRes.ok ? ((await eRes.json()) as { events: EventItem[] }).events : [];
  const krows = kRes.ok ? ((await kRes.json()) as { knowledge: KRow[] }).knowledge : [];

  const byTopic = new Map<string, Knowledge[]>();
  for (const k of krows) {
    const topic = k.skill || "General";
    const item: Knowledge = {
      id: k.id,
      title: k.title || "(untitled)",
      summary: k.summary || "",
      body: { h: k.title || "Knowledge", p: k.summary ? [k.summary] : [] },
    };
    const arr = byTopic.get(topic) ?? [];
    arr.push(item);
    byTopic.set(topic, arr);
  }
  const topics = [...byTopic.entries()].map(([topic, items]) => ({ topic, items }));
  return { notes, events, topics };
}

const TABS: { id: Area; label: string }[] = [
  { id: "notes", label: "Notes" },
  { id: "events", label: "Events" },
  { id: "knowledge", label: "Knowledge" },
];

export function MemoryScreen(): React.ReactElement {
  const [data, setData] = React.useState<MemData>({ notes: [], events: [], topics: [] });
  React.useEffect(() => {
    let cancelled = false;
    loadMemory()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        /* leave empty on failure */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <MemoryContext.Provider value={data}>
      <MemoryScreenInner />
    </MemoryContext.Provider>
  );
}

function MemoryScreenInner(): React.ReactElement {
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

function EmptyArea({ what }: { what: string }): React.ReactElement {
  return (
    <div className="empty" style={{ padding: "24px 0" }}>
      <div className="empty__body">No {what} yet.</div>
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
  const { notes } = useMem();
  if (notes.length === 0) return <EmptyArea what="notes" />;
  const pinned = notes.filter((n) => n.pinned);
  const rest = notes.filter((n) => !n.pinned);
  return (
    <div className="mem-list">
      {pinned.length > 0 ? <div className="mem-group">Pinned</div> : null}
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
  const { notes } = useMem();
  const n = notes.find((x) => x.id === id);
  if (!n) {
    return (
      <div className="content">
        <div className="mem-detail">
          <DetailBar label="Memory" onBack={onBack} />
          <EmptyArea what="note" />
        </div>
      </div>
    );
  }
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
  const { notes } = useMem();
  const n = notes.find((x) => x.id === id) ?? notes[0];
  if (!n) {
    return (
      <div className="content">
        <div className="mem-detail">
          <DetailBar label="Cancel" onBack={onDone} />
          <EmptyArea what="note" />
        </div>
      </div>
    );
  }
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
  const { events } = useMem();
  const filters = ["All", "Today", "Due", "Pending"];
  const map: Record<string, EventItem["status"]> = { Today: "today", Due: "due", Pending: "pending" };
  const shown =
    filter === "All"
      ? events
      : events.filter((e) => e.status === map[filter] || (filter === "Due" && e.zone === "alert"));
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
  const { events } = useMem();
  const e = events.find((x) => x.id === id);
  const zLabel: Record<Zone, string> = { alert: "Overdue", warn: "Due soon", info: "Scheduled", good: "Done" };
  if (!e) {
    return (
      <div className="content">
        <div className="mem-detail">
          <DetailBar label="Events" onBack={onBack} />
          <EmptyArea what="event" />
        </div>
      </div>
    );
  }
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
  const { topics } = useMem();
  if (topics.length === 0) return <EmptyArea what="knowledge" />;
  return (
    <div className="mem-list">
      {topics.map((grp) => (
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
  const { topics } = useMem();
  let k: Knowledge | null = null;
  let topic = "";
  for (const g of topics) {
    for (const it of g.items) {
      if (it.id === id) {
        k = it;
        topic = g.topic;
      }
    }
  }
  if (!k) {
    return (
      <div className="content">
        <div className="mem-detail">
          <DetailBar label="Knowledge" onBack={onBack} />
          <EmptyArea what="knowledge" />
        </div>
      </div>
    );
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
