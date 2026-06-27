// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

// A file's own screen (reached at its /files/<path> permalink, not a popup): view it, edit its
// markdown/text inline, save, download, or delete. Markdown renders with GFM + mermaid/chart fenced
// blocks — so you can draft a prompt spec as a real file and tweak it before pasting it into a chat.

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, Download, Pencil, Save, Trash2 } from "lucide-react";

import { authFetch } from "@/lib/auth";
import { MermaidBlock } from "@/components/conversation/MermaidBlock";
import { ChartBlock } from "@/components/conversation/ChartBlock";
import { MentionAnchor } from "@/components/conversation/MentionChip";
import { useTextareaMentions } from "@/components/conversation/useTextareaMentions";
import { RichMarkdownEditor } from "@/components/conversation/RichMarkdownEditor";

export interface FileScreenEntry { id: string; name: string; mime: string | null; source: string }

function isMarkdown(name: string, mime: string | null): boolean {
  return /\.(md|markdown)$/i.test(name) || (mime ?? "").includes("markdown");
}
function isTextish(name: string, mime: string | null): boolean {
  const m = (mime ?? "").toLowerCase();
  return (
    m.startsWith("text/") || m.includes("json") || m.includes("xml") ||
    /\.(md|markdown|txt|json|ya?ml|csv|tsv|log|js|ts|tsx|jsx|py|sql|sh|toml|ini|env|css|html?)$/i.test(name)
  );
}

// Pull the fenced-block language + raw text out of a <pre>'s hast node (so ```mermaid / ```chart render).
function fenced(node: unknown): { lang?: string; text: string } {
  const code = (node as { children?: Array<{ tagName?: string; properties?: { className?: unknown }; children?: Array<{ value?: string }> }> })
    ?.children?.find((c) => c.tagName === "code");
  const cls = code?.properties?.className;
  const lang = Array.isArray(cls)
    ? (cls.find((c) => typeof c === "string" && c.startsWith("language-")) as string | undefined)?.slice(9)
    : undefined;
  const text = code?.children?.map((c) => c.value ?? "").join("") ?? "";
  return { lang, text };
}

function MarkdownView({ content }: { content: string }): React.ReactElement {
  return (
    <div className="md-body" style={{ fontSize: "var(--fs-14)", lineHeight: 1.6 }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => { void node; return <MentionAnchor {...props} />; },
          pre: ({ node, children, ...props }) => {
            const { lang, text } = fenced(node);
            if (lang === "mermaid") return <MermaidBlock code={text} />;
            if (lang === "chart") return <ChartBlock config={text} />;
            return <pre {...props}>{children}</pre>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export function FileScreen({ entry, onBack, onDeleted }: { entry: FileScreenEntry; onBack: () => void; onDeleted: () => void }): React.ReactElement {
  const md = isMarkdown(entry.name, entry.mime);
  const editable = isTextish(entry.name, entry.mime);
  const [content, setContent] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  const [editing, setEditing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const taRef = React.useRef<HTMLTextAreaElement | null>(null);
  const mentions = useTextareaMentions(taRef, draft, setDraft);
  const rawUrl = `/api/fs/blob?id=${encodeURIComponent(entry.id)}`;

  React.useEffect(() => {
    let cancelled = false;
    setContent(null); setErr(null); setEditing(false);
    if (!editable) return;
    void (async () => {
      try {
        const r = await authFetch(rawUrl);
        if (!r.ok) throw new Error(`load failed (${r.status})`);
        const t = await r.text();
        if (!cancelled) { setContent(t); setDraft(t); }
      } catch (e) { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)); }
    })();
    return () => { cancelled = true; };
  }, [entry.id, editable, rawUrl]);

  const save = async (): Promise<void> => {
    setBusy(true); setErr(null);
    try {
      const r = await authFetch("/api/fs/file", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: entry.id, content: draft }) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `save failed (${r.status})`);
      setContent(draft); setEditing(false);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  const del = async (): Promise<void> => {
    if (typeof window !== "undefined" && !window.confirm(`Delete "${entry.name}"? It's removed from your files (recoverable from the archive).`)) return;
    setBusy(true); setErr(null);
    try {
      const r = await authFetch(`/api/fs?id=${encodeURIComponent(entry.id)}`, { method: "DELETE" });
      if (!r.ok) throw new Error(`delete failed (${r.status})`);
      onDeleted();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--s3)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap" }}>
        <button className="btn btn--ghost btn--sm" onClick={onBack} title="Back to folder"><ArrowLeft className="i i-sm" aria-hidden /></button>
        <div className="card__title" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</div>
        {editable && !editing ? (
          <button className="btn btn--ghost btn--sm" onClick={() => { setDraft(content ?? ""); setEditing(true); }} title="Edit"><Pencil className="i i-sm" aria-hidden /> Edit</button>
        ) : null}
        {editing ? <button className="btn btn--primary btn--sm" disabled={busy} onClick={() => void save()}><Save className="i i-sm" aria-hidden /> {busy ? "Saving…" : "Save"}</button> : null}
        {editing ? <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => { setEditing(false); setDraft(content ?? ""); }}>Cancel</button> : null}
        <a className="btn btn--ghost btn--sm" href={rawUrl} target="_blank" rel="noopener noreferrer" title="Open raw / download"><Download className="i i-sm" aria-hidden /></a>
        <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void del()} title="Delete" style={{ color: "var(--alert)" }}><Trash2 className="i i-sm" aria-hidden /></button>
      </div>
      {err ? <p className="screen-sub" style={{ color: "var(--alert)" }}>{err}</p> : null}
      {!editable ? (
        <p className="screen-sub">Binary file — <a href={rawUrl} target="_blank" rel="noopener noreferrer">download</a> to view.</p>
      ) : content == null ? (
        <div className="skel" style={{ height: 240 }} />
      ) : editing ? (
        md ? (
          // Markdown files get the rich editor (formatting + @-mention of files/agents/…); raw text/code
          // keep the monospace textarea so their exact bytes round-trip.
          <RichMarkdownEditor value={draft} onChange={setDraft} minRows={20} />
        ) : (
          <div style={{ position: "relative" }}>
            <textarea
              ref={taRef}
              value={draft}
              onChange={(e) => { setDraft(e.target.value); mentions.recompute(); }}
              onKeyUp={() => mentions.recompute()}
              onClick={() => mentions.recompute()}
              onKeyDown={(e) => { mentions.handleKeyDown(e); }}
              spellCheck={false}
              aria-label={`Edit ${entry.name}`}
              style={{ width: "100%", minHeight: "60vh", fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: "var(--fs-13)", lineHeight: 1.5, resize: "vertical", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: "var(--s3)", background: "var(--bg)", color: "var(--text)" }}
            />
            {mentions.popover}
          </div>
        )
      ) : md ? (
        <MarkdownView content={content} />
      ) : (
        <pre style={{ whiteSpace: "pre-wrap", fontSize: "var(--fs-13)", overflow: "auto", margin: 0 }}>{content}</pre>
      )}
    </div>
  );
}
