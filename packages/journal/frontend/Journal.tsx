// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

// Journal panel — drop a raw note (rich markdown, @-mentions, voice-in via Telegram/chat); the engine
// agent categorises it per the editable direction prompt and records each item via journal_capture,
// opening a sage code job for any bug/task that names a repo. Capture runs THROUGH the engine (POST
// /api/turn) because tools execute in the engine, not the web tier; the browse list + the direction
// editor read/write plugin_journal.* directly over RLS-scoped Next routes. Uses the shared
// RichMarkdownEditor and the app's theme tokens so it tracks light/dark like every other surface.
import * as React from "react";

import { authFetch } from "@/lib/auth";
import { streamTurn } from "@/lib/api/turn";
import { RichMarkdownEditor } from "@/components/conversation/RichMarkdownEditor";

interface Entry {
  id: string;
  project: string | null;
  entry_type: string;
  summary: string;
  target_repo: string | null;
  job_id: string | null;
  created_at: string;
}

const TYPES = ["devlog", "bug", "task", "idea", "content_seed"] as const;
const TYPE_LABEL: Record<string, string> = {
  devlog: "devlog", bug: "bug", task: "task", idea: "idea", content_seed: "content",
};

const CAPTURE_DIRECTIVE =
  "The following is a journal note the operator just dropped. Read the journal direction with " +
  "journal_direction, then split the note into distinct items and record EACH one with " +
  "journal_capture (set project + entry_type, and target_repo for a bug/task with a known repo). " +
  "Don't reply with prose — just capture. Note:\n\n";

function convId(): string {
  const KEY = "eidan.journal.capture.conv";
  try {
    let id = window.localStorage.getItem(KEY);
    if (!id) { id = crypto.randomUUID(); window.localStorage.setItem(KEY, id); }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

// Group entries under a human day label for the browse list.
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today); y.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Today";
  if (same(d, y)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

export default function Journal(): React.ReactElement {
  const [entries, setEntries] = React.useState<Entry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [limit, setLimit] = React.useState(50);
  const [reachedEnd, setReachedEnd] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [capturing, setCapturing] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);
  const [fProject, setFProject] = React.useState("");
  const [fType, setFType] = React.useState("");

  // direction editor
  const [dirOpen, setDirOpen] = React.useState(false);
  const [dir, setDir] = React.useState("");
  const [dirIsDefault, setDirIsDefault] = React.useState(true);
  const [dirSaving, setDirSaving] = React.useState(false);

  const loadEntries = React.useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (fProject.trim()) qs.set("project", fProject.trim());
      if (fType) qs.set("entry_type", fType);
      qs.set("limit", String(limit));
      const r = await authFetch(`/api/journal?${qs}`);
      const j = (await r.json()) as { entries?: Entry[] };
      const list = j.entries ?? [];
      setEntries(list);
      setReachedEnd(list.length < limit);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [fProject, fType, limit]);

  React.useEffect(() => { void loadEntries(); }, [loadEntries]);

  const loadDirection = React.useCallback(async () => {
    try {
      const r = await authFetch("/api/journal/direction");
      const j = (await r.json()) as { direction_prompt?: string | null; is_default?: boolean };
      setDir(j.direction_prompt ?? "");
      setDirIsDefault(j.is_default !== false);
    } catch { /* leave as-is */ }
  }, []);

  const openDirection = React.useCallback(() => {
    setDirOpen((o) => {
      if (!o) void loadDirection();
      return !o;
    });
  }, [loadDirection]);

  const saveDirection = React.useCallback(async () => {
    setDirSaving(true);
    try {
      const r = await authFetch("/api/journal/direction", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: dir }),
      });
      if (r.ok) { setDirIsDefault(!dir.trim()); setStatus("Direction prompt saved."); }
    } catch { setStatus("Could not save the direction prompt."); }
    finally { setDirSaving(false); }
  }, [dir]);

  const drop = React.useCallback(async () => {
    const raw = note.trim();
    if (!raw || capturing) return;
    setCapturing(true);
    setStatus("Capturing…");
    const toolNames = new Map<string, string>();
    let captured = 0;
    let jobs = 0;
    try {
      for await (const ev of streamTurn({ conversationId: convId(), text: CAPTURE_DIRECTIVE + raw })) {
        if (ev.kind === "tool_call_start") toolNames.set(ev.tool_call_id, ev.tool_name);
        else if (ev.kind === "tool_call_result" && toolNames.get(ev.tool_call_id) === "journal_capture") {
          captured += 1;
          if (/"routed"\s*:\s*"code_job"|"job_id"/.test(ev.content)) jobs += 1;
        } else if (ev.kind === "error") {
          setStatus(`Capture failed: ${ev.message}`);
        }
      }
      setNote("");
      setStatus(
        captured
          ? `Captured ${captured} item${captured === 1 ? "" : "s"}${jobs ? ` · opened ${jobs} sage job${jobs === 1 ? "" : "s"}` : ""}.`
          : "Nothing captured — try a clearer note, or edit the direction prompt.",
      );
      await loadEntries();
    } catch (e) {
      setStatus(`Capture failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCapturing(false);
    }
  }, [note, capturing, loadEntries]);

  // ⌘/Ctrl+Enter submits from inside the rich editor.
  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void drop(); }
  };

  // Group for the browse list.
  const groups = React.useMemo(() => {
    const out: Array<{ label: string; items: Entry[] }> = [];
    for (const e of entries) {
      const label = dayLabel(e.created_at);
      const g = out[out.length - 1];
      if (g && g.label === label) g.items.push(e);
      else out.push({ label, items: [e] });
    }
    return out;
  }, [entries]);

  return (
    <div className="journal">
      <h2 className="journal-title">Journal</h2>
      <p className="journal-sub">
        Drop a note about what you built, found, or want — it&rsquo;s categorised, logged, and a bug/task
        with a repo opens a sage job. Voice notes work in Telegram &amp; chat (spoken → text automatically).
      </p>

      <div className="journal-drop" onKeyDownCapture={onKeyDownCapture}>
        <RichMarkdownEditor
          value={note}
          onChange={setNote}
          minRows={3}
          placeholder="e.g. built the journal panel in eidan today; found a scoring bug in mathgame → sielay/mathgame"
        />
        <div className="journal-row">
          <button className="journal-btn primary" onClick={() => void drop()} disabled={capturing || !note.trim()}>
            {capturing ? "Capturing…" : "Drop note"}
          </button>
          <span className="journal-hint">⌘/Ctrl + Enter</span>
          <span className="journal-spacer" />
          <button className="journal-btn ghost" onClick={openDirection}>
            {dirOpen ? "Hide direction" : "Direction prompt"}
          </button>
        </div>
        {status && <div className="journal-status">{status}</div>}
      </div>

      {dirOpen && (
        <div className="journal-direction">
          <div className="journal-hint">
            How notes are categorised &amp; routed{dirIsDefault ? " — built-in default in use; edit to override" : ""}
          </div>
          <RichMarkdownEditor value={dir} onChange={setDir} minRows={10} placeholder="Type your own direction prompt to override the built-in default…" />
          <div className="journal-row">
            <button className="journal-btn primary" onClick={() => void saveDirection()} disabled={dirSaving}>
              {dirSaving ? "Saving…" : "Save direction"}
            </button>
            <span className="journal-hint">Clear the box and save to fall back to the default.</span>
          </div>
        </div>
      )}

      <div className="journal-browse-head">
        <span className="journal-browse-title">Browse</span>
        <input className="journal-filter" placeholder="filter project…" value={fProject} onChange={(e) => { setLimit(50); setFProject(e.target.value); }} />
        <select className="journal-filter" value={fType} onChange={(e) => { setLimit(50); setFType(e.target.value); }}>
          <option value="">all types</option>
          {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
      </div>

      <div className="journal-list">
        {loading && entries.length === 0 ? (
          <div className="journal-empty">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="journal-empty">No entries yet — drop your first note above.</div>
        ) : (
          groups.map((g) => (
            <div key={g.label} className="journal-group">
              <div className="journal-group-label">{g.label}</div>
              {g.items.map((e) => (
                <div key={e.id} className="journal-entry">
                  <span className={`journal-type journal-type-${e.entry_type}`}>{TYPE_LABEL[e.entry_type] ?? e.entry_type}</span>
                  <div className="journal-entry-body">
                    <div className="journal-entry-summary">{e.summary}</div>
                    <div className="journal-entry-meta">
                      {e.project && <span className="journal-tag">{e.project}</span>}
                      {e.target_repo && <span className="journal-tag mono">{e.target_repo}</span>}
                      {e.job_id && <span className="journal-tag job">→ sage job</span>}
                      <span className="journal-time">{new Date(e.created_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
        {!loading && !reachedEnd && entries.length > 0 && (
          <button className="journal-btn ghost journal-more" onClick={() => setLimit((l) => l + 50)}>Load more</button>
        )}
      </div>
    </div>
  );
}
