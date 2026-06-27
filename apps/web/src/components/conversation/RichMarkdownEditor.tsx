// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { useEditor, EditorContent, ReactRenderer } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import type { SuggestionOptions, SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion";
import { Bold, Bot, Box, Briefcase, FileText, Folder, Heading2, Heading3, Italic, List, ListOrdered } from "lucide-react";

import { searchMentions, type MentionHit } from "@/lib/api/mentions";
import { placeAnchored } from "@/components/agents/anchor";
import { buildRichExtensions, getRichMarkdown, linkifyEntityMentions } from "./entity-tiptap";

const ICON: Record<MentionHit["type"], React.ComponentType<{ className?: string }>> = {
  file: FileText, folder: Folder, agent: Bot, venture: Briefcase, asset: Box,
};

interface ListRef { onKeyDown: (p: { event: KeyboardEvent }) => boolean }
interface ListProps { items: MentionHit[]; command: (m: { id: string; label: string; mtype: string }) => void }

// The @-mention popover list — keyboard-navigable, one row per entity.
const EntityList = React.forwardRef<ListRef, ListProps>(function EntityList({ items, command }, ref) {
  const [sel, setSel] = React.useState(0);
  React.useEffect(() => setSel(0), [items]);
  const pick = (i: number): void => { const it = items[i]; if (it) command({ id: it.id, label: it.label, mtype: it.type }); };
  React.useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (!items.length) return false;
      if (event.key === "ArrowDown") { setSel((s) => (s + 1) % items.length); return true; }
      if (event.key === "ArrowUp") { setSel((s) => (s - 1 + items.length) % items.length); return true; }
      if (event.key === "Enter" || event.key === "Tab") { pick(sel); return true; }
      return false;
    },
  }), [items, sel]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!items.length) return <div style={{ padding: "6px 10px", fontSize: 12, color: "var(--faint)", background: "var(--bg,#fff)", border: "1px solid var(--border)", borderRadius: 8 }}>No matches</div>;
  return (
    <ul role="listbox" style={{ minWidth: 280, maxWidth: 420, maxHeight: 260, overflowY: "auto", margin: 0, padding: 4, listStyle: "none", background: "var(--bg,#fff)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "0 8px 28px rgba(0,0,0,0.18)" }}>
      {items.map((h, i) => {
        const Icon = ICON[h.type];
        return (
          <li key={`${h.type}:${h.id}`}>
            <button type="button" role="option" aria-selected={i === sel} onMouseDown={(e) => { e.preventDefault(); pick(i); }} onMouseEnter={() => setSel(i)}
              style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "6px 8px", border: "none", borderRadius: 6, cursor: "pointer", background: i === sel ? "var(--accent-soft, rgba(99,102,241,0.12))" : "transparent", color: "var(--text)" }}>
              <Icon className="i i-sm" aria-hidden />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{h.label}</span>
              <span style={{ fontSize: 11, color: "var(--faint)", textTransform: "uppercase" }}>{h.type}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
});

function buildEntitySuggestion(): Omit<SuggestionOptions<MentionHit>, "editor"> {
  return {
    char: "@",
    items: async ({ query }) => (query.trim() ? await searchMentions(query).catch(() => []) : []),
    command: ({ editor, range, props }: { editor: Editor; range: { from: number; to: number }; props: { id?: string; label?: string; mtype?: string } }) => {
      const nodeAfter = editor.view.state.selection.$to.nodeAfter;
      const to = nodeAfter?.text?.startsWith(" ") ? range.to + 1 : range.to;
      editor.chain().focus().insertContentAt({ from: range.from, to }, [
        { type: "mention", attrs: { id: props.id, label: props.label, mtype: props.mtype } },
        { type: "text", text: " " },
      ]).run();
    },
    render: () => {
      let renderer: ReactRenderer<ListRef, ListProps> | null = null;
      let box: HTMLDivElement | null = null;
      const place = (rect: DOMRect | null | undefined): void => { if (box && rect) placeAnchored(box, { top: rect.top, bottom: rect.bottom, left: rect.left }); };
      return {
        onStart: (props: SuggestionProps<MentionHit>) => {
          renderer = new ReactRenderer(EntityList, { props: { items: props.items, command: props.command } satisfies ListProps, editor: props.editor });
          box = document.createElement("div");
          box.style.zIndex = "60";
          box.appendChild(renderer.element);
          document.body.appendChild(box);
          place(props.clientRect?.());
          requestAnimationFrame(() => place(props.clientRect?.()));
        },
        onUpdate: (props: SuggestionProps<MentionHit>) => { renderer?.updateProps({ items: props.items, command: props.command }); place(props.clientRect?.()); },
        onKeyDown: (props: SuggestionKeyDownProps) => {
          if (props.event.key === "Escape") { box?.remove(); return true; }
          return renderer?.ref?.onKeyDown({ event: props.event }) ?? false;
        },
        onExit: () => { box?.remove(); box = null; renderer?.destroy(); renderer = null; },
      };
    },
  };
}

function Toolbar({ editor }: { editor: Editor | null }): React.ReactElement | null {
  if (!editor) return null;
  const btn = (active: boolean, onClick: () => void, label: string, Icon: React.ComponentType<{ className?: string }>): React.ReactElement => (
    <button type="button" aria-label={label} title={label} aria-pressed={active} onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      style={{ display: "inline-flex", padding: 4, borderRadius: 5, border: "none", cursor: "pointer", background: active ? "var(--accent-soft, rgba(99,102,241,0.16))" : "transparent", color: active ? "var(--accent-link, #4f46e5)" : "var(--muted)" }}>
      <Icon className="i i-sm" aria-hidden />
    </button>
  );
  return (
    <div style={{ display: "flex", gap: 2, padding: "4px 6px", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
      {btn(editor.isActive("bold"), () => editor.chain().focus().toggleBold().run(), "Bold", Bold)}
      {btn(editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run(), "Italic", Italic)}
      {btn(editor.isActive("heading", { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run(), "Heading", Heading2)}
      {btn(editor.isActive("heading", { level: 3 }), () => editor.chain().focus().toggleHeading({ level: 3 }).run(), "Subheading", Heading3)}
      {btn(editor.isActive("bulletList"), () => editor.chain().focus().toggleBulletList().run(), "Bullet list", List)}
      {btn(editor.isActive("orderedList"), () => editor.chain().focus().toggleOrderedList().run(), "Numbered list", ListOrdered)}
      <span style={{ flex: 1 }} />
      <span style={{ fontSize: 10, color: "var(--faint)", alignSelf: "center", paddingRight: 4 }}>@ to mention</span>
    </div>
  );
}

// Reusable rich markdown editor (TipTap): formatting toolbar + markdown round-trip + @-mention of
// files/folders/agents/ventures/assets (resolvable tokens the engine expands). Drop-in for any markdown
// body — value is markdown in, markdown out.
export function RichMarkdownEditor({ value, onChange, minRows = 6, placeholder }: {
  value: string;
  onChange: (markdown: string) => void;
  minRows?: number;
  placeholder?: string;
}): React.ReactElement {
  const lastEmitted = React.useRef<string>(value);
  const linked = React.useRef(false);
  const editor = useEditor({
    immediatelyRender: false,
    extensions: buildRichExtensions(buildEntitySuggestion()),
    content: value,
    editorProps: {
      attributes: {
        class: "persona-prose md-body w-full px-3 py-2 focus:outline-none",
        style: `min-height:${minRows * 1.6}rem`,
        ...(placeholder ? { "data-placeholder": placeholder } : {}),
      },
    },
    onUpdate: ({ editor }) => { const md = getRichMarkdown(editor); lastEmitted.current = md; onChange(md); },
  }, []);

  React.useEffect(() => { if (editor && !linked.current) { linked.current = true; linkifyEntityMentions(editor); } }, [editor]);
  React.useEffect(() => {
    if (!editor) return;
    if (value !== lastEmitted.current && value !== getRichMarkdown(editor)) {
      editor.commands.setContent(value);
      linkifyEntityMentions(editor);
      lastEmitted.current = getRichMarkdown(editor);
    }
  }, [editor, value]);

  return (
    <div className="rich-md-editor" style={{ overflow: "hidden", borderRadius: "var(--r-sm)", border: "1px solid var(--border)", background: "var(--bg)" }}>
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
}
