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
} from "lucide-react";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { authFetch } from "@/lib/auth";
import {
  getKnowledgeRow,
  updateKnowledgeRow,
  KnowledgeConflictError,
  type KnowledgeDetail as KnowledgeRow,
} from "@/lib/api/knowledge";

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
interface MemDataRows {
  notes: Note[];
  events: EventItem[];
  topics: { topic: string; items: Knowledge[] }[];
}
interface MemData extends MemDataRows {
  reload: () => void;
}
const MemoryContext = React.createContext<MemData>({ notes: [], events: [], topics: [], reload: () => {} });
function useMem(): MemData {
  return React.useContext(MemoryContext);
}

interface KRow {
  id: string;
  title: string | null;
  skill: string | null;
  summary: string;
}

async function loadMemory(): Promise<MemDataRows> {
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
  const [data, setData] = React.useState<MemDataRows>({ notes: [], events: [], topics: [] });
  const reload = React.useCallback(() => {
    loadMemory()
      .then(setData)
      .catch(() => {
        /* leave previous data on failure */
      });
  }, []);
  React.useEffect(() => {
    reload();
  }, [reload]);
  return (
    <MemoryContext.Provider value={{ ...data, reload }}>
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
  const { notes, reload } = useMem();
  const n = notes.find((x) => x.id === id);
  const [content, setContent] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Load the raw note content (the list only carries a split/snippet form).
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    authFetch(`/api/notes/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`load failed (${r.status})`))))
      .then((j: { note: { content: string } }) => {
        if (!cancelled) setContent(j.note.content ?? "");
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "failed to load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const r = await authFetch(`/api/notes/${id}`, { method: "PATCH", body: JSON.stringify({ content }) });
      if (!r.ok) throw new Error(`save failed (${r.status})`);
      reload();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="content">
      <div className="mem-detail">
        <div className="mem-detail__bar">
          <button type="button" className="iconbtn mem-backbtn" onClick={onDone} disabled={saving}>
            <ChevronLeft className="i-sm" aria-hidden />
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            style={{ minHeight: 38 }}
            onClick={() => void save()}
            disabled={saving || loading}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
        {n ? <h1 className="mem-detail__title">{n.title}</h1> : null}
        <div className="field">
          <span className="field__label">Note</span>
          <textarea
            className="input mem-textarea"
            style={{ minHeight: 280, width: "100%", fontSize: "var(--fs-15)" }}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            disabled={loading || saving}
            autoFocus
          />
        </div>
        {error ? (
          <p className="login-err is-on" role="alert" style={{ marginTop: "var(--s3)" }}>
            {error}
          </p>
        ) : null}
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

// Fetches the FULL knowledge row (not the list summary), renders the body as markdown, and edits it
// inline (PATCH /api/knowledge/[id]).
function KnowledgeDetail({ id, onBack }: { id: string; onBack: () => void }): React.ReactElement {
  const { topics, reload } = useMem();
  const topic = topics.find((g) => g.items.some((it) => it.id === id))?.topic ?? "";

  const [row, setRow] = React.useState<KnowledgeRow | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [mode, setMode] = React.useState<"preview" | "edit">("preview");
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMode("preview"); // re-targeting the detail must not keep a stale edit textarea
    getKnowledgeRow(id)
      .then((d) => {
        if (cancelled) return;
        setRow(d);
        setDraft(d.body);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "failed to load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function save(): Promise<void> {
    if (!row || draft === row.body) {
      setMode("preview");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await updateKnowledgeRow(row.id, { body: draft, expected_updated_at: row.updated_at });
      setRow(updated);
      setDraft(updated.body);
      setMode("preview");
      reload(); // refresh the list so its title/summary aren't stale
    } catch (e) {
      if (e instanceof KnowledgeConflictError) {
        // Someone (or the agent) edited this row since we loaded it — refetch so the operator sees
        // the current text and a retry sends a fresh expected_updated_at.
        try {
          const fresh = await getKnowledgeRow(row.id);
          setRow(fresh);
          setError("This entry changed since you opened it — it's been refreshed. Re-apply your edit.");
        } catch {
          setError("This entry changed since you opened it.");
        }
      } else {
        setError(e instanceof Error ? e.message : "failed to save");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="content">
      <div className="mem-detail">
        <div className="mem-detail__bar">
          <button type="button" className="iconbtn mem-backbtn" onClick={onBack}>
            <ChevronLeft className="i-sm" aria-hidden />
            Knowledge
          </button>
          {row ? (
            mode === "preview" ? (
              <button type="button" className="iconbtn" onClick={() => setMode("edit")}>
                <Pencil className="i-sm" aria-hidden />
                Edit
              </button>
            ) : (
              <div className="erow" style={{ gap: 8 }}>
                <button
                  type="button"
                  className="iconbtn"
                  onClick={() => {
                    setDraft(row.body);
                    setMode("preview");
                  }}
                  disabled={saving}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  style={{ minHeight: 36 }}
                  onClick={() => void save()}
                  disabled={saving || draft === row.body}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            )
          ) : null}
        </div>
        {topic ? <div className="memtag" style={{ marginBottom: "var(--s2)" }}>{topic}</div> : null}
        <h1 className="mem-detail__title">{row?.title ?? (loading ? "Loading…" : "Knowledge")}</h1>
        {loading ? (
          <p className="onb-lede">Loading…</p>
        ) : !row ? (
          <EmptyArea what="knowledge" />
        ) : mode === "edit" ? (
          <textarea
            className="input mem-textarea"
            style={{ minHeight: 300, width: "100%", fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: "var(--fs-14)" }}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
          />
        ) : (
          <div className="md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{row.body}</ReactMarkdown>
          </div>
        )}
        {error ? (
          <p className="login-err is-on" role="alert" style={{ marginTop: "var(--s3)" }}>
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
