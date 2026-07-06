// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

// Shared boards UI — a board switcher + kanban (To do / Doing / Done) + a card detail drawer with
// typed references and an activity log. Bundle-agnostic: parameterised by scope (scopeKind/scopeId),
// so the Charles Ventures screen (scope venture:<id>), the standalone Planner (no scope), and later
// Charlotte all reuse it over the same /api/boards* routes. Committed core infra (not bundle-written),
// hence it lives in _shared. Layout uses inline styles so it renders correctly in any plugin context;
// chrome uses the global design system (.card/.field/.input/.btn/.pill).

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";

import { authFetch } from "@/lib/auth";
import { Avatar } from "@/plugins/_shared/Avatar";
import { RichMarkdownEditor } from "@/components/conversation/RichMarkdownEditor";
import { ContentCardDrawer } from "@/plugins/_shared/ContentCardDrawer";

interface Board { id: string; name: string; prompt?: string | null; position: number; status: string }
interface Card { id: string; board_id: string; title: string; body: string | null; status: string; ref_count?: number; due_date?: string | null; metadata?: { labels?: string[] }; conversation_id?: string | null; parent_card_id?: string | null; channels?: string[]; publish_at?: string | null; frozen_data?: Record<string, unknown> }

// Deterministic pastel colour per label name (no palette table needed).
function labelHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}
function LabelChip({ name, onRemove }: { name: string; onRemove?: () => void }): React.ReactElement {
  const hue = labelHue(name);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "var(--fs-13)", lineHeight: 1.4, padding: "1px 6px", borderRadius: 999, background: `hsl(${hue} 70% 92%)`, color: `hsl(${hue} 60% 30%)`, border: `1px solid hsl(${hue} 60% 82%)` }}>
      {name}
      {onRemove ? <button onClick={(e) => { e.stopPropagation(); onRemove(); }} title="Remove label" style={{ border: "none", background: "none", cursor: "pointer", color: "inherit", padding: 0, lineHeight: 1 }}>×</button> : null}
    </span>
  );
}
interface CardRef { id: string; card_id: string; ref_kind: string; ref_id: string | null; ref_label: string | null }
interface CardEvent { id: string; kind: string; body: string | null; author_kind?: string; author_id?: string | null; author_label?: string | null; created_at: string }

const LANES: Array<[string, string]> = [["open", "To do"], ["doing", "Doing"], ["done", "Done"]];
const ORDER = ["open", "doing", "done"];
const REF_KINDS: Array<[string, string]> = [
  ["asset", "Asset"], ["venture", "Venture"], ["job", "Job"], ["agent", "Agent"],
  ["domain", "Domain"], ["social_account", "Social account"], ["url", "URL"], ["note", "Note"],
  ["conversation", "Conversation"], ["artifact", "Artifact"],
];

const S = {
  tabs: { display: "flex", flexWrap: "wrap" as const, alignItems: "center", gap: "var(--s2)", margin: "var(--s3) 0" },
  tab: (active: boolean) => ({ border: "1px solid var(--border)", background: active ? "var(--surface-2, rgba(120,120,140,.08))" : "none", color: active ? "var(--text)" : "var(--muted)", borderColor: active ? "var(--muted)" : "var(--border)", borderRadius: "var(--r-sm)", padding: "4px var(--s2)", fontSize: "var(--fs-13)", fontWeight: 600, cursor: "pointer" }),
  addRow: { display: "flex", gap: "var(--s2)", margin: "var(--s3) 0" },
  board: { display: "flex", gap: "var(--s3)", overflowX: "auto" as const, paddingBottom: "var(--s2)" },
  lane: { flex: "1 1 0", minWidth: 170, background: "var(--surface-2, rgba(120,120,140,.06))", border: "1px solid var(--border)", borderRadius: "var(--r-md)", padding: "var(--s2)", display: "flex", flexDirection: "column" as const, gap: "var(--s2)" },
  laneHead: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "var(--fs-13)", fontWeight: 600, color: "var(--muted)", padding: "0 var(--s1)" },
  card: { background: "var(--bg, #fff)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: "var(--s2)", cursor: "pointer", display: "flex", flexDirection: "column" as const, gap: 4 },
  cardActions: { display: "flex", gap: "var(--s1)", justifyContent: "flex-end" },
  btn: { border: "1px solid var(--border)", background: "none", cursor: "pointer", color: "var(--muted)", borderRadius: "var(--r-sm)", minWidth: 26, height: 24, fontSize: "var(--fs-13)", lineHeight: 1, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 6px" },
  scrim: { position: "fixed" as const, inset: 0, zIndex: 70, background: "rgba(20,20,30,.36)", display: "flex", justifyContent: "flex-end" },
  drawer: { width: "min(420px, 100%)", height: "100%", overflowY: "auto" as const, background: "var(--bg, #fff)", borderLeft: "1px solid var(--border)", padding: "var(--s4)", display: "flex", flexDirection: "column" as const, gap: "var(--s3)" },
};

export function BoardsPanel({ scopeKind = null, scopeId = null, basePath, lanes }: { scopeKind?: string | null; scopeId?: string | null; basePath?: string; lanes?: Array<[string, string]> }): React.ReactElement {
  // Columns are configurable (a content-workflow board has Concept→Assets→Copy→Review, not the default
  // To do/Doing/Done). New cards land in the first lane; move arrows walk the lane order.
  const LANE_DEFS = lanes && lanes.length ? lanes : LANES;
  const ORD = React.useMemo(() => LANE_DEFS.map((l) => l[0]), [LANE_DEFS]);
  const router = useRouter();
  const pathname = usePathname();
  // When a basePath is given, the active board lives in the URL (`<basePath>/<board-id>`) so each board
  // has a permalink and back/forward work — house rule: path, not query string. The board id is the
  // first segment after basePath (the venture screen ignores it; it only reads its own slug segment).
  const urlBoardId = React.useMemo(() => {
    if (!basePath || !pathname || !pathname.startsWith(basePath)) return "";
    const rest = pathname.slice(basePath.length).replace(/^\/+/, "");
    return rest ? decodeURIComponent(rest.split("/")[0]) : "";
  }, [basePath, pathname]);
  const [boards, setBoards] = React.useState<Board[]>([]);
  const [activeBoard, setActiveBoard] = React.useState("");
  const [boardsLoading, setBoardsLoading] = React.useState(true);
  const [cards, setCards] = React.useState<Card[]>([]);
  const [cardsLoading, setCardsLoading] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [boardInput, setBoardInput] = React.useState("");
  const [mode, setMode] = React.useState<null | "add" | "rename">(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [openCard, setOpenCard] = React.useState<Card | null>(null);
  const [promptEditing, setPromptEditing] = React.useState(false);
  const [promptInput, setPromptInput] = React.useState("");

  const scopeQS = scopeKind ? `scope_kind=${encodeURIComponent(scopeKind)}${scopeId ? `&scope_id=${encodeURIComponent(scopeId)}` : ""}` : "";

  const loadBoards = React.useCallback(async () => {
    setBoardsLoading(true);
    try {
      const r = await authFetch(`/api/boards${scopeQS ? `?${scopeQS}` : ""}`);
      const j = (await r.json().catch(() => ({}))) as { boards?: Board[] };
      const list = j.boards ?? [];
      setBoards(list);
      setActiveBoard((cur) => (list.some((b) => b.id === cur) ? cur : list[0]?.id ?? ""));
    } catch { setBoards([]); } finally { setBoardsLoading(false); }
  }, [scopeQS]);

  const loadCards = React.useCallback(async (boardId: string) => {
    if (!boardId) { setCards([]); return; }
    setCardsLoading(true);
    try {
      const r = await authFetch(`/api/boards/cards?board=${encodeURIComponent(boardId)}`);
      const j = (await r.json().catch(() => ({}))) as { cards?: Card[] };
      setCards(j.cards ?? []);
    } catch { setCards([]); } finally { setCardsLoading(false); }
  }, []);

  React.useEffect(() => { void loadBoards(); }, [loadBoards]);
  React.useEffect(() => { void loadCards(activeBoard); }, [activeBoard, loadCards]);
  // Follow the URL (permalink + browser back/forward) when basePath routing is on.
  React.useEffect(() => {
    if (basePath && urlBoardId && boards.some((b) => b.id === urlBoardId)) setActiveBoard(urlBoardId);
  }, [basePath, urlBoardId, boards]);

  // Select a board AND, when permalinked, push its URL so it's shareable/back-able.
  const selectBoard = React.useCallback((id: string): void => {
    setActiveBoard(id);
    if (basePath && id) router.push(`${basePath}/${encodeURIComponent(id)}`);
  }, [basePath, router]);

  async function createBoard(): Promise<void> {
    const n = boardInput.trim();
    if (!n) return;
    setBusy(true); setErr(null);
    try {
      const r = await authFetch(`/api/boards`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n, scope_kind: scopeKind ?? undefined, scope_id: scopeId ?? undefined }) });
      const j = (await r.json()) as { error?: string; board?: Board };
      if (!r.ok) throw new Error(j.error ?? "add board failed");
      setBoardInput(""); setMode(null);
      await loadBoards();
      if (j.board?.id) selectBoard(j.board.id);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  async function renameBoard(): Promise<void> {
    const n = boardInput.trim();
    if (!n || !activeBoard) return;
    setBusy(true); setErr(null);
    try {
      const r = await authFetch(`/api/boards`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: activeBoard, name: n }) });
      if (!r.ok) throw new Error(`rename failed (${r.status})`);
      setMode(null); setBoardInput("");
      await loadBoards();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  async function deleteBoard(): Promise<void> {
    if (!activeBoard) return;
    setBusy(true); setErr(null);
    try {
      const r = await authFetch(`/api/boards?id=${encodeURIComponent(activeBoard)}`, { method: "DELETE" });
      if (!r.ok) throw new Error(`delete failed (${r.status})`);
      setActiveBoard(""); await loadBoards();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  async function saveBoardPrompt(): Promise<void> {
    if (!activeBoard) return;
    setBusy(true); setErr(null);
    try {
      const r = await authFetch(`/api/boards`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: activeBoard, prompt: promptInput }) });
      if (!r.ok) throw new Error(`save failed (${r.status})`);
      setPromptEditing(false); await loadBoards();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  async function addCard(): Promise<void> {
    const t = title.trim();
    if (!t || !activeBoard) return;
    setBusy(true); setErr(null);
    try {
      const r = await authFetch(`/api/boards/cards`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ board_id: activeBoard, title: t, status: ORD[0] }) });
      const j = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? "add failed");
      setTitle(""); await loadCards(activeBoard);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  async function moveCard(card: Card, dir: -1 | 1): Promise<void> {
    const next = ORD[ORD.indexOf(card.status) + dir];
    if (!next) return;
    setBusy(true);
    setCards((xs) => xs.map((x) => (x.id === card.id ? { ...x, status: next } : x)));
    try {
      const r = await authFetch(`/api/boards/cards`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: card.id, status: next }) });
      if (!r.ok) throw new Error();
    } catch { await loadCards(activeBoard); } finally { setBusy(false); }
  }

  async function archiveCard(card: Card): Promise<void> {
    setBusy(true);
    setCards((xs) => xs.filter((x) => x.id !== card.id));
    try {
      const r = await authFetch(`/api/boards/cards?id=${encodeURIComponent(card.id)}`, { method: "DELETE" });
      if (!r.ok) throw new Error();
    } catch { await loadCards(activeBoard); } finally { setBusy(false); }
  }

  const boardInputEditor = (onSave: () => void): React.ReactElement => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--s1)" }}>
      <input className="input" autoFocus style={{ width: 150, padding: "4px var(--s2)", fontSize: "var(--fs-13)" }}
        placeholder={mode === "add" ? "Board name…" : "Rename board…"} value={boardInput}
        onChange={(e) => setBoardInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") onSave(); if (e.key === "Escape") { setMode(null); setBoardInput(""); } }} />
      <button style={S.btn} disabled={busy || !boardInput.trim()} title="Save" onClick={onSave}>✓</button>
      <button style={S.btn} title="Cancel" onClick={() => { setMode(null); setBoardInput(""); }}>×</button>
    </span>
  );

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card__head">
        <div className="card__title">Boards</div>
        <span className="screen-sub" style={{ margin: 0 }}>{cards.length} {cards.length === 1 ? "card" : "cards"}</span>
      </div>

      <div style={S.tabs}>
        {boardsLoading ? (
          <div className="skel" style={{ height: 30, width: 120 }} />
        ) : (
          boards.map((b) => (
            <button key={b.id} style={S.tab(b.id === activeBoard)} onClick={() => selectBoard(b.id)}
              onDoubleClick={() => { selectBoard(b.id); setBoardInput(b.name); setMode("rename"); }} title="Double-click to rename">
              {b.name}
            </button>
          ))
        )}
        {mode === "add" ? boardInputEditor(() => void createBoard())
          : mode === "rename" ? boardInputEditor(() => void renameBoard())
            : <button style={{ ...S.tab(false), borderStyle: "dashed" }} onClick={() => { setMode("add"); setBoardInput(""); }}>+ Board</button>}
        {mode === null && activeBoard ? (
          <span style={{ marginLeft: "auto", display: "inline-flex", gap: "var(--s1)" }}>
            <button style={S.btn} title="Rename board" disabled={busy} onClick={() => { const b = boards.find((x) => x.id === activeBoard); setBoardInput(b?.name ?? ""); setMode("rename"); }}>✎</button>
            {boards.length > 1 ? <button style={S.btn} title="Delete board (and its cards)" disabled={busy} onClick={() => void deleteBoard()}>×</button> : null}
          </span>
        ) : null}
      </div>

      {activeBoard ? (() => {
        const active = boards.find((b) => b.id === activeBoard);
        const prompt = active?.prompt ?? "";
        return (
          <div style={{ margin: "var(--s2) 0" }}>
            {promptEditing ? (
              <>
                <RichMarkdownEditor value={promptInput} onChange={setPromptInput} minRows={4} placeholder="What is this board for? Standing context given to agents working its cards…" />
                <div style={{ display: "flex", gap: "var(--s1)", marginTop: "var(--s1)" }}>
                  <button className="btn btn--primary" disabled={busy} onClick={() => void saveBoardPrompt()}>Save</button>
                  <button style={S.btn} disabled={busy} onClick={() => setPromptEditing(false)}>Cancel</button>
                </div>
              </>
            ) : prompt ? (
              <div style={{ display: "flex", gap: "var(--s2)", alignItems: "flex-start" }}>
                <p className="screen-sub" style={{ margin: 0, whiteSpace: "pre-wrap", flex: 1 }}>{prompt.replace(/\[([^\]]+)\]\(eidan:[^)]+\)/g, "@$1")}</p>
                <button style={S.btn} title="Edit board prompt" onClick={() => { setPromptInput(prompt); setPromptEditing(true); }}>✎</button>
              </div>
            ) : (
              <button style={{ ...S.tab(false), borderStyle: "dashed", fontWeight: 500 }} onClick={() => { setPromptInput(""); setPromptEditing(true); }}>+ Add board context / prompt</button>
            )}
          </div>
        );
      })() : null}

      {activeBoard ? (
        <div style={S.addRow}>
          <input className="input" style={{ flex: 1 }} placeholder="Add a card…" value={title}
            onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void addCard(); }} />
          <button className="btn btn--primary" disabled={busy || !title.trim()} onClick={() => void addCard()}>Add</button>
        </div>
      ) : !boardsLoading ? (
        <p className="screen-sub">No boards yet — add one to start planning.</p>
      ) : null}

      {err ? <p className="screen-sub" style={{ color: "var(--alert)" }}>{err}</p> : null}

      {cardsLoading ? (
        <div className="skel" style={{ height: 120 }} />
      ) : activeBoard ? (
        <div style={S.board}>
          {LANE_DEFS.map(([status, lbl]) => {
            const lane = cards.filter((c) => c.status === status);
            const idx = ORD.indexOf(status);
            return (
              <div style={S.lane} key={status}>
                <div style={S.laneHead}>{lbl}<span className="num">{lane.length}</span></div>
                {lane.length === 0 ? <p className="screen-sub" style={{ margin: "4px 0" }}>—</p> : lane.map((c) => (
                  <div style={S.card} key={c.id} onClick={() => setOpenCard(c)}>
                    {c.metadata?.labels?.length ? (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {c.metadata.labels.map((l) => <LabelChip key={l} name={l} />)}
                      </div>
                    ) : null}
                    <span style={{ fontSize: "var(--fs-14)", lineHeight: 1.3 }}>{c.title}</span>
                    {c.due_date ? <div style={{ fontSize: "var(--fs-12)", color: "var(--muted)" }}>📅 {new Date(c.due_date).toLocaleDateString()}</div> : null}
                    <div style={S.cardActions}>
                      {c.ref_count ? <span className="screen-sub" style={{ margin: 0, marginRight: "auto", fontSize: "var(--fs-13)" }}>🔗 {c.ref_count}</span> : null}
                      <button style={S.btn} disabled={busy || idx === 0} title="Move left" onClick={(e) => { e.stopPropagation(); void moveCard(c, -1); }}>←</button>
                      <button style={S.btn} disabled={busy || idx === ORD.length - 1} title="Move right" onClick={(e) => { e.stopPropagation(); void moveCard(c, 1); }}>→</button>
                      <button style={S.btn} disabled={busy} title="Archive" onClick={(e) => { e.stopPropagation(); void archiveCard(c); }}>×</button>
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      ) : null}

      {openCard ? scopeKind === "content" ? (
        <ContentCardDrawer card={openCard} onClose={() => setOpenCard(null)} onChanged={() => void loadCards(activeBoard)} />
      ) : (
        <CardDrawer card={openCard} onClose={() => setOpenCard(null)} onChanged={() => void loadCards(activeBoard)} />
      ) : null}
    </div>
  );
}

// ── Card detail drawer: body, typed refs, activity log ───────────────────────
function CardDrawer({ card, onClose, onChanged }: { card: Card; onClose: () => void; onChanged: () => void }): React.ReactElement {
  const [refs, setRefs] = React.useState<CardRef[]>([]);
  const [events, setEvents] = React.useState<CardEvent[]>([]);
  const [comment, setComment] = React.useState("");
  const [refKind, setRefKind] = React.useState("asset");
  const [refLabel, setRefLabel] = React.useState("");
  const [refId, setRefId] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  // Editable title + body (Trello-style).
  const [title, setTitle] = React.useState(card.title);
  const [body, setBody] = React.useState(card.body ?? "");
  const [dueDate, setDueDate] = React.useState(card.due_date ?? "");
  const [savingCard, setSavingCard] = React.useState(false);
  const dirty = title.trim() !== card.title || body.trim() !== (card.body ?? "") || (dueDate || null) !== card.due_date;
  const [labels, setLabels] = React.useState<string[]>(card.metadata?.labels ?? []);
  const [newLabel, setNewLabel] = React.useState("");

  async function saveLabels(next: string[]): Promise<void> {
    setLabels(next);
    await authFetch(`/api/boards/cards`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: card.id, labels: next }) });
    onChanged();
  }

  async function saveCard(): Promise<void> {
    if (!title.trim() || !dirty) return;
    setSavingCard(true);
    try {
      await authFetch(`/api/boards/cards`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: card.id, title: title.trim(), body: body.trim(), due_date: dueDate || null }) });
      onChanged();
    } finally { setSavingCard(false); }
  }

  const load = React.useCallback(async () => {
    const [rr, er] = await Promise.all([
      authFetch(`/api/boards/cards/refs?card=${encodeURIComponent(card.id)}`),
      authFetch(`/api/boards/cards/events?card=${encodeURIComponent(card.id)}`),
    ]);
    setRefs(((await rr.json().catch(() => ({}))) as { refs?: CardRef[] }).refs ?? []);
    setEvents(((await er.json().catch(() => ({}))) as { events?: CardEvent[] }).events ?? []);
  }, [card.id]);
  React.useEffect(() => { void load(); }, [load]);

  async function addRef(): Promise<void> {
    if (!refLabel.trim() && !refId.trim()) return;
    setBusy(true);
    try {
      await authFetch(`/api/boards/cards/refs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ card_id: card.id, ref_kind: refKind, ref_id: refId.trim() || undefined, ref_label: refLabel.trim() || undefined }) });
      setRefLabel(""); setRefId(""); await load(); onChanged();
    } finally { setBusy(false); }
  }
  async function removeRef(id: string): Promise<void> {
    setBusy(true);
    try { await authFetch(`/api/boards/cards/refs?id=${encodeURIComponent(id)}`, { method: "DELETE" }); await load(); onChanged(); } finally { setBusy(false); }
  }
  async function addComment(): Promise<void> {
    const t = comment.trim();
    if (!t) return;
    setBusy(true);
    try { await authFetch(`/api/boards/cards/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ card_id: card.id, body: t }) }); setComment(""); await load(); } finally { setBusy(false); }
  }

  const kindLabel = (k: string): string => REF_KINDS.find(([v]) => v === k)?.[1] ?? k;

  return (
    <div style={S.scrim} role="dialog" aria-modal="true" aria-label="Card detail" onClick={onClose}>
      <div style={S.drawer} onClick={(e) => e.stopPropagation()}>
        <div className="card__head" style={{ marginTop: 0 }}>
          <span className="screen-sub" style={{ margin: 0 }}>Card</span>
          <button className="btn btn--ghost" onClick={onClose}>Close</button>
        </div>

        <div className="field">
          <input className="input" style={{ fontWeight: 600, fontSize: "var(--fs-16, 1rem)" }} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Card title" />
          <textarea className="input" style={{ minHeight: 90, resize: "vertical", marginTop: "var(--s2)" }} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a description…" />
          <input className="input" type="date" style={{ marginTop: "var(--s2)" }} value={dueDate} onChange={(e) => setDueDate(e.target.value)} title="Due date" />
          {dirty ? (
            <div style={{ display: "flex", gap: "var(--s2)", marginTop: "var(--s2)" }}>
              <button className="btn btn--primary" disabled={savingCard || !title.trim()} onClick={() => void saveCard()}>{savingCard ? "Saving…" : "Save"}</button>
              <button className="btn btn--ghost" disabled={savingCard} onClick={() => { setTitle(card.title); setBody(card.body ?? ""); setDueDate(card.due_date ?? ""); }}>Reset</button>
            </div>
          ) : null}
        </div>

        <div>
          <div className="screen-sub" style={{ marginTop: 0, fontWeight: 600 }}>Labels</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: "var(--s2)" }}>
            {labels.map((l) => <LabelChip key={l} name={l} onRemove={() => void saveLabels(labels.filter((x) => x !== l))} />)}
            <input
              className="input"
              style={{ width: 130, padding: "2px var(--s2)", fontSize: "var(--fs-13)" }}
              placeholder="+ label"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const v = newLabel.trim();
                  if (v && !labels.includes(v)) void saveLabels([...labels, v]);
                  setNewLabel("");
                }
              }}
            />
          </div>
        </div>

        <div>
          <div className="screen-sub" style={{ marginTop: 0, fontWeight: 600 }}>Linked to</div>
          {refs.length === 0 ? <p className="screen-sub" style={{ margin: "4px 0" }}>Nothing linked yet.</p> : (
            <div className="loglist">
              {refs.map((r) => (
                <div className="logrow" key={r.id}>
                  <span className="logrow__main">
                    <span className="logrow__primary">{r.ref_label || r.ref_id || "(unlabelled)"}</span>
                    <span className="logrow__meta">{kindLabel(r.ref_kind)}{r.ref_id && r.ref_label ? ` · ${r.ref_id}` : ""}</span>
                  </span>
                  <button style={S.btn} disabled={busy} title="Remove" onClick={() => void removeRef(r.id)}>×</button>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s2)", marginTop: "var(--s2)" }}>
            <select className="input" style={{ width: 130 }} value={refKind} onChange={(e) => setRefKind(e.target.value)}>
              {REF_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <input className="input" style={{ flex: 1, minWidth: 120 }} placeholder="label (e.g. acme.com)" value={refLabel} onChange={(e) => setRefLabel(e.target.value)} />
            <input className="input" style={{ flex: 1, minWidth: 120 }} placeholder="id (optional)" value={refId} onChange={(e) => setRefId(e.target.value)} />
            <button className="btn btn--ghost" disabled={busy || (!refLabel.trim() && !refId.trim())} onClick={() => void addRef()}>Link</button>
          </div>
        </div>

        <div>
          <div className="screen-sub" style={{ fontWeight: 600 }}>Activity</div>
          {events.length === 0 ? <p className="screen-sub" style={{ margin: "4px 0" }}>No activity yet.</p> : (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
              {events.map((e) => {
                const isComment = e.kind === "comment";
                const authorKind = e.author_kind === "agent" ? "agent" : "user";
                const authorLabel = e.author_label || (authorKind === "agent" ? "Eidan" : "You");
                return (
                  <div key={e.id} style={{ display: "flex", gap: "var(--s2)", alignItems: "flex-start" }}>
                    {isComment ? <Avatar kind={authorKind} seed={e.author_id || authorLabel} size={22} title={authorLabel} /> : null}
                    <div style={{ flex: 1, borderLeft: isComment ? "none" : "2px solid var(--border)", paddingLeft: isComment ? 0 : "var(--s2)" }}>
                      {isComment ? (
                        <>
                          <div style={{ fontSize: "var(--fs-13)", fontWeight: 600 }}>{authorLabel}</div>
                          <div style={{ fontSize: "var(--fs-14)" }}>{e.body}</div>
                        </>
                      ) : (
                        <div style={{ fontSize: "var(--fs-14)" }}><em>{e.kind}: {e.body}</em></div>
                      )}
                      <div className="screen-sub" style={{ margin: 0, fontSize: "var(--fs-13)" }}>{new Date(e.created_at).toLocaleString()}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ display: "flex", gap: "var(--s2)", marginTop: "var(--s2)" }}>
            <input className="input" style={{ flex: 1 }} placeholder="Add a comment…" value={comment}
              onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void addComment(); }} />
            <button className="btn btn--primary" disabled={busy || !comment.trim()} onClick={() => void addComment()}>Comment</button>
          </div>
        </div>
      </div>
    </div>
  );
}
