// SPDX-License-Identifier: AGPL-3.0-or-later
// TipTap wiring for the reusable RichMarkdownEditor: StarterKit + markdown round-trip + an @-mention of
// workspace entities (files/folders/agents/ventures/assets). An entity mention serialises to the SAME
// resolvable token the plain-textarea mentions use — `[label](eidan:type:id)` — so the engine expands it
// at turn time and every markdown renderer shows it as a chip. Kept React-free so it stays testable.
import type { Editor, Extensions } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import { Markdown } from "tiptap-markdown";
import type { SuggestionOptions } from "@tiptap/suggestion";

import type { MentionHit } from "@/lib/api/mentions";

// Mirror of the engine/textarea token: [label](eidan:type:id).
export const ENTITY_RE = /\[([^\]]+)\]\(eidan:(file|folder|agent|venture|asset):([^)\s]+)\)/g;

interface MdSerializerState { write(s: string): void }
type EntityAttrs = { id?: string | null; label?: string | null; mtype?: string | null };

// The Mention node, carrying the entity `mtype` and serialising back to the markdown-link token.
export const EntityMention = Mention.extend({
  addAttributes() {
    const parent = this.parent?.() ?? {};
    return {
      ...parent,
      mtype: {
        default: "file",
        parseHTML: (el: HTMLElement): string => el.getAttribute("data-mtype") || "file",
        renderHTML: (attrs: { mtype?: string }) => (attrs.mtype ? { "data-mtype": attrs.mtype } : {}),
      },
    };
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: MdSerializerState, node: { attrs: EntityAttrs }) {
          const id = node.attrs.id ?? "";
          const label = (node.attrs.label ?? id) || id;
          const mtype = node.attrs.mtype ?? "file";
          state.write(`[${label}](eidan:${mtype}:${id})`);
        },
        parse: {},
      },
    };
  },
});

export function getRichMarkdown(editor: Editor): string {
  const storage = editor.storage as { markdown?: { getMarkdown?: () => string } };
  return storage.markdown?.getMarkdown?.() ?? "";
}

// After markdown loads, turn each `[label](eidan:type:id)` into a mention chip (end-first so positions
// stay valid as we splice).
export function linkifyEntityMentions(editor: Editor): void {
  const mentionType = editor.state.schema.nodes["mention"];
  if (!mentionType) return;
  const hits: Array<{ from: number; to: number; id: string; label: string; mtype: string }> = [];
  editor.state.doc.descendants((node: PMNode, pos: number) => {
    if (!node.isText || !node.text) return;
    ENTITY_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ENTITY_RE.exec(node.text)) !== null) {
      hits.push({ from: pos + m.index, to: pos + m.index + m[0].length, label: m[1] ?? "", mtype: m[2] ?? "file", id: m[3] ?? "" });
    }
  });
  if (!hits.length) return;
  let tr = editor.state.tr;
  for (const h of hits.sort((a, b) => b.from - a.from)) {
    tr = tr.replaceWith(h.from, h.to, mentionType.create({ id: h.id, label: h.label, mtype: h.mtype }));
  }
  editor.view.dispatch(tr);
}

export function buildRichExtensions(suggestion?: Omit<SuggestionOptions<MentionHit>, "editor">): Extensions {
  return [
    StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
    // GFM tables: the schema nodes the agent's markdown tables deserialise into (tiptap-markdown
    // round-trips `table`/`tableRow`/`tableHeader`/`tableCell` to pipe-table markdown). Without these
    // nodes a pasted/loaded table silently collapses to plain text. `resizable` gives drag handles.
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    Markdown.configure({ html: false, breaks: true, transformPastedText: true, transformCopiedText: true }),
    EntityMention.configure({
      HTMLAttributes: { class: "eidan-mention" },
      deleteTriggerWithBackspace: true,
      renderHTML({ node }: { node: { attrs: EntityAttrs } }) {
        const label = (node.attrs.label ?? node.attrs.id ?? "") || "";
        return ["span", { class: "eidan-mention", "data-mention": node.attrs.id ?? "" }, `@${label}`];
      },
      renderText({ node }: { node: { attrs: EntityAttrs } }) {
        const id = node.attrs.id ?? "";
        const label = (node.attrs.label ?? id) || id;
        return `[${label}](eidan:${node.attrs.mtype ?? "file"}:${id})`;
      },
      ...(suggestion ? { suggestion } : {}),
    }),
  ];
}
