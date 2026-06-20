// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import React from "react";
import { useEditor, EditorContent, ReactRenderer } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import type { SuggestionOptions, SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion";
import { AtSign, Bold, Heading2, Italic, List, ListOrdered } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolCatalogEntry } from "@/lib/api/admin";
import { MentionList, type MentionListRef } from "./MentionList";
import { MentionParamForm } from "./MentionParamForm";
import { placeAnchored, type AnchorRect } from "./anchor";
import { buildPersonaExtensions, linkifyMentions, getMarkdown, setMentionParams, type MentionParams } from "./persona-tiptap";

interface MentionListProps {
  items: ToolCatalogEntry[];
  command: (item: { id: string; label: string }) => void;
}

// The TipTap suggestion that powers the @ popover. Reads tools from a ref so the editor is built once
// yet always offers the latest catalogue; renders MentionList into a body-anchored box positioned at
// the caret (no tippy.js dependency).
function buildSuggestion(
  toolsRef: React.RefObject<ToolCatalogEntry[]>,
  onInsertedRef: React.RefObject<(pos: number, id: string) => void>,
): Omit<SuggestionOptions, "editor"> {
  return {
    char: "@",
    items: ({ query }) => {
      const q = query.toLowerCase();
      return toolsRef.current
        .filter(
          (t) =>
            t.name.toLowerCase().includes(q) ||
            t.description.toLowerCase().includes(q) ||
            (t.plugin ?? "").toLowerCase().includes(q),
        )
        .slice(0, 40);
    },
    // Insert the mention (replicating the default mention command) then signal React so a tool with
    // params auto-opens its form — codify the call right after picking it, no extra click.
    command: ({ editor, range, props }: { editor: Editor; range: { from: number; to: number }; props: { id?: string; label?: string } }) => {
      const nodeAfter = editor.view.state.selection.$to.nodeAfter;
      const to = nodeAfter?.text?.startsWith(" ") ? range.to + 1 : range.to;
      editor.chain().focus().insertContentAt({ from: range.from, to }, [
        { type: "mention", attrs: props },
        { type: "text", text: " " },
      ]).run();
      const id = props.id ?? "";
      const pos = range.from;
      requestAnimationFrame(() => onInsertedRef.current(pos, id));
    },
    render: () => {
      let renderer: ReactRenderer<MentionListRef, MentionListProps> | null = null;
      let box: HTMLDivElement | null = null;
      const place = (rect: DOMRect | null | undefined): void => {
        if (!box || !rect) return;
        placeAnchored(box, { top: rect.top, bottom: rect.bottom, left: rect.left });
      };
      return {
        onStart: (props: SuggestionProps<ToolCatalogEntry>) => {
          renderer = new ReactRenderer(MentionList, {
            props: { items: props.items, command: props.command } satisfies MentionListProps,
            editor: props.editor,
          });
          box = document.createElement("div");
          box.style.zIndex = "60";
          box.appendChild(renderer.element);
          document.body.appendChild(box);
          place(props.clientRect?.());
          // Re-place once the list has measured so flip-above uses its real height.
          requestAnimationFrame(() => place(props.clientRect?.()));
        },
        onUpdate: (props: SuggestionProps<ToolCatalogEntry>) => {
          renderer?.updateProps({ items: props.items, command: props.command });
          place(props.clientRect?.());
        },
        onKeyDown: (props: SuggestionKeyDownProps) => {
          if (props.event.key === "Escape") {
            box?.remove();
            return true;
          }
          return renderer?.ref?.onKeyDown({ event: props.event }) ?? false;
        },
        onExit: () => {
          box?.remove();
          box = null;
          renderer?.destroy();
          renderer = null;
        },
      };
    },
  };
}

export function PersonaEditor({
  value,
  onChange,
  tools,
  rows = 4,
}: {
  value: string;
  onChange: (markdown: string) => void;
  tools: ToolCatalogEntry[];
  rows?: number;
}): React.ReactElement {
  const toolsRef = React.useRef<ToolCatalogEntry[]>(tools);
  toolsRef.current = tools;
  const toolNamesRef = React.useRef<Set<string>>(new Set());
  toolNamesRef.current = React.useMemo(() => new Set(tools.map((t) => t.name)), [tools]);
  const lastEmitted = React.useRef<string>(value);
  const linked = React.useRef(false);
  const [paramForm, setParamForm] = React.useState<
    { pos: number; tool: ToolCatalogEntry; params: MentionParams; anchor: AnchorRect } | null
  >(null);
  // Assigned after the editor exists; the suggestion's insert command calls it so a tool with params
  // auto-opens its form. A ref so the (once-built) suggestion always sees the latest closure.
  const openParamFormRef = React.useRef<(pos: number, id: string) => void>(() => {});

  const editor = useEditor(
    {
      immediatelyRender: false,
      extensions: buildPersonaExtensions(buildSuggestion(toolsRef, openParamFormRef)),
      content: value,
      editorProps: {
        attributes: {
          class: "persona-prose min-h-[var(--persona-min)] w-full px-2 py-1.5 text-sm focus:outline-none",
          style: `--persona-min:${rows * 1.5}rem`,
        },
        // Click a tool chip → open its schema-driven param form so the call can be codified.
        handleClickOn: (view: EditorView, _pos: number, node: PMNode, nodePos: number) => {
          if (node.type.name !== "mention") return false;
          const id = node.attrs["id"] as string | undefined;
          const tool = id ? toolsRef.current.find((t) => t.name === id) : undefined;
          if (!tool) return false;
          const coords = view.coordsAtPos(nodePos);
          setParamForm({
            pos: nodePos,
            tool,
            params: (node.attrs["params"] as MentionParams) ?? {},
            anchor: { top: coords.top, bottom: coords.bottom, left: coords.left },
          });
          return true;
        },
      },
      onUpdate: ({ editor }) => {
        const md = getMarkdown(editor);
        lastEmitted.current = md;
        onChange(md);
      },
    },
    [],
  );

  // Open a just-inserted tool's param form when it has params (captures the latest editor + tools).
  openParamFormRef.current = (pos: number, id: string): void => {
    if (!editor) return;
    const tool = toolsRef.current.find((t) => t.name === id);
    const props = tool?.inputSchema?.properties;
    if (!tool || !props || Object.keys(props).length === 0) return;
    const coords = editor.view.coordsAtPos(pos);
    setParamForm({ pos, tool, params: {}, anchor: { top: coords.top, bottom: coords.bottom, left: coords.left } });
  };

  // Linkify the initial content once the editor is ready.
  React.useEffect(() => {
    if (editor && !linked.current) {
      linked.current = true;
      linkifyMentions(editor, toolNamesRef.current);
    }
  }, [editor]);

  // Reflect external resets (e.g. an edit-form cancel) without clobbering in-progress typing.
  React.useEffect(() => {
    if (!editor) return;
    if (value !== lastEmitted.current && value !== getMarkdown(editor)) {
      editor.commands.setContent(value);
      linkifyMentions(editor, toolNamesRef.current);
      lastEmitted.current = getMarkdown(editor);
    }
  }, [editor, value]);

  return (
    <div className="persona-editor overflow-hidden rounded border border-border bg-background focus-within:ring-1 focus-within:ring-ring">
      <PersonaToolbar editor={editor} />
      <EditorContent editor={editor} />
      {paramForm ? (
        <AnchoredOverlay anchor={paramForm.anchor} onClose={() => setParamForm(null)}>
          <MentionParamForm
            tool={paramForm.tool}
            params={paramForm.params}
            onChange={(p) => {
              if (editor) setMentionParams(editor, paramForm.pos, p);
              setParamForm((f) => (f ? { ...f, params: p } : f));
            }}
            onClose={() => setParamForm(null)}
          />
        </AnchoredOverlay>
      ) : null}
    </div>
  );
}

// A click-dismissable overlay that positions itself near an anchor (flip-above / clamp / mobile sheet).
function AnchoredOverlay({
  anchor, onClose, children,
}: { anchor: AnchorRect; onClose: () => void; children: React.ReactNode }): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    if (ref.current) placeAnchored(ref.current, anchor);
  }, [anchor]);
  return (
    <>
      <div className="fixed inset-0 z-[65]" onMouseDown={onClose} />
      <div ref={ref} style={{ position: "fixed", zIndex: 70 }}>
        {children}
      </div>
    </>
  );
}

function ToolbarButton({
  active, onClick, title, children,
}: { active?: boolean; onClick: () => void; title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <button
      type="button"
      title={title}
      // preventDefault so clicking the toolbar keeps the editor selection.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn("rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground", active && "bg-muted text-foreground")}
    >
      {children}
    </button>
  );
}

function PersonaToolbar({ editor }: { editor: Editor | null }): React.ReactElement | null {
  if (!editor) return null;
  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-border bg-muted/40 px-1 py-0.5">
      <ToolbarButton title="Bold (⌘B)" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold size={14} />
      </ToolbarButton>
      <ToolbarButton title="Italic (⌘I)" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic size={14} />
      </ToolbarButton>
      <ToolbarButton title="Heading" active={editor.isActive("heading", { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
        <Heading2 size={14} />
      </ToolbarButton>
      <span className="mx-0.5 h-4 w-px bg-border" />
      <ToolbarButton title="Bullet list" active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}>
        <List size={14} />
      </ToolbarButton>
      <ToolbarButton title="Numbered list" active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        <ListOrdered size={14} />
      </ToolbarButton>
      <span className="mx-0.5 h-4 w-px bg-border" />
      <ToolbarButton title="Insert a tool reference (@)" onClick={() => editor.chain().focus().insertContent("@").run()}>
        <AtSign size={14} />
      </ToolbarButton>
      <span className="ml-1 select-none text-[10px] text-muted-foreground">type @ to reference a tool</span>
    </div>
  );
}
