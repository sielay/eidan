// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { FileText, Folder, Bot, Briefcase, Box } from "lucide-react";

import { searchMentions, mentionToken, type MentionHit } from "@/lib/api/mentions";

// @-mention autocomplete for a plain <textarea> (the chat composer, file/markdown editors). Type `@`
// then a query; pick a file/folder/agent/venture/asset and it inserts a resolvable token
// `[label](eidan:type:id)` that the engine expands at turn time. Returns a popover element to render
// next to the textarea plus key/caret handlers the host wires into its existing textarea events.
//
// Kept framework-light (no tiptap) so it drops into any controlled textarea: the host owns value/onChange
// and just calls `recompute()` after edits/caret moves and lets `handleKeyDown` claim arrows/enter/esc
// while the popover is open.

const ICON: Record<MentionHit["type"], React.ComponentType<{ className?: string }>> = {
  file: FileText, folder: Folder, agent: Bot, venture: Briefcase, asset: Box,
};

// Find an active `@query` immediately before the caret: the last `@` that starts the line or follows
// whitespace, with no newline between it and the caret. Returns the query + the `@`'s index, or null.
function activeQuery(text: string, caret: number): { q: string; at: number } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at < 0) return null;
  const before = at === 0 ? "" : upto[at - 1] ?? "";
  if (before && !/\s/.test(before)) return null; // must be at start or after whitespace (not an email)
  const q = upto.slice(at + 1);
  if (q.includes("\n") || q.length > 40) return null;
  return { q, at };
}

export function useTextareaMentions(
  taRef: React.RefObject<HTMLTextAreaElement | null>,
  value: string,
  setValue: (next: string) => void,
): { popover: React.ReactNode; handleKeyDown: (e: React.KeyboardEvent) => boolean; recompute: () => void; active: boolean } {
  const [query, setQuery] = React.useState<string | null>(null);
  const [at, setAt] = React.useState(0);
  const [hits, setHits] = React.useState<MentionHit[]>([]);
  const [sel, setSel] = React.useState(0);
  const seq = React.useRef(0);

  const recompute = React.useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    const found = activeQuery(ta.value, ta.selectionStart ?? ta.value.length);
    if (!found) { setQuery(null); return; }
    setQuery(found.q); setAt(found.at);
  }, [taRef]);

  // Debounced search whenever the active query changes.
  React.useEffect(() => {
    if (query === null) { setHits([]); setSel(0); return; }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      void searchMentions(query).then((r) => { if (seq.current === mine) { setHits(r); setSel(0); } }).catch(() => { if (seq.current === mine) setHits([]); });
    }, 140);
    return () => clearTimeout(t);
  }, [query]);

  const pick = React.useCallback((hit: MentionHit) => {
    const ta = taRef.current;
    if (!ta) return;
    const caret = ta.selectionStart ?? ta.value.length;
    const token = mentionToken(hit) + " ";
    const next = value.slice(0, at) + token + value.slice(caret);
    setValue(next);
    setQuery(null); setHits([]);
    const pos = at + token.length;
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(pos, pos); });
  }, [taRef, value, at, setValue]);

  const open = query !== null && hits.length > 0;

  const handleKeyDown = React.useCallback((e: React.KeyboardEvent): boolean => {
    if (!open) return false;
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (s + 1) % hits.length); return true; }
    if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (s - 1 + hits.length) % hits.length); return true; }
    if (e.key === "Enter" || e.key === "Tab") { const h = hits[sel]; if (h) { e.preventDefault(); pick(h); return true; } }
    if (e.key === "Escape") { e.preventDefault(); setQuery(null); return true; }
    return false;
  }, [open, hits, sel, pick]);

  const popover = open ? (
    <ul
      role="listbox"
      aria-label="Mention suggestions"
      style={{
        position: "absolute", bottom: "calc(100% + 6px)", left: 0, zIndex: 50, width: "min(420px, 90vw)",
        maxHeight: 280, overflowY: "auto", margin: 0, padding: 4, listStyle: "none",
        background: "var(--bg, #fff)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "0 8px 28px rgba(0,0,0,0.18)",
      }}
    >
      {hits.map((h, i) => {
        const Icon = ICON[h.type];
        return (
          <li key={`${h.type}:${h.id}`}>
            <button
              type="button"
              role="option"
              aria-selected={i === sel}
              onMouseDown={(e) => { e.preventDefault(); pick(h); }}
              onMouseEnter={() => setSel(i)}
              style={{
                display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                padding: "6px 8px", border: "none", borderRadius: 6, cursor: "pointer",
                background: i === sel ? "var(--accent-soft, rgba(99,102,241,0.12))" : "transparent", color: "var(--text)",
              }}
            >
              <Icon className="i i-sm" aria-hidden />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{h.label}</span>
              <span style={{ fontSize: 11, color: "var(--faint)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{h.type}</span>
            </button>
          </li>
        );
      })}
    </ul>
  ) : null;

  return { popover, handleKeyDown, recompute, active: open };
}
