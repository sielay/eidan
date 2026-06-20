// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure TipTap wiring for the persona editor — the schema + markdown round-trip, kept free of React so
// it is unit-testable headlessly. The React component (PersonaEditor) supplies the suggestion popover
// and the per-tool param form.
import type { Editor } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Extensions } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import { Markdown } from "tiptap-markdown";
import type { SuggestionOptions } from "@tiptap/suggestion";

export type MentionParams = Record<string, string | number | boolean>;

// A tool reference is plain text `@tool_name` or `@tool_name(arg=value, arg2="quoted value")` — exactly
// what the model reads. Names allow letters, digits, `_` and `-`; an optional `(...)` carries codified
// call params so the agent's tool call is deterministic instead of inferred.
export const MENTION_RE = /@([a-zA-Z][a-zA-Z0-9_-]*)(\([^)]*\))?/g;

// ── param (de)serialisation ───────────────────────────────────────────────────────
function serializeValue(v: string | number | boolean): string {
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return /[\s,()"=]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
}

export function serializeParams(params: MentionParams | undefined): string {
  if (!params) return "";
  const keys = Object.keys(params).filter((k) => params[k] !== undefined && params[k] !== "" && params[k] !== null);
  if (keys.length === 0) return "";
  return `(${keys.map((k) => `${k}=${serializeValue(params[k] as string | number | boolean)}`).join(", ")})`;
}

// Parse the inside of `(...)` — `k=v, k2="quoted"` — into typed params. Bare numeric/boolean values are
// coerced; everything else is a string. Tolerant of hand-edits.
export function parseParams(inner: string): MentionParams {
  const out: MentionParams = {};
  const re = /([a-zA-Z_][\w-]*)\s*=\s*("(?:[^"\\]|\\.)*"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    const key = m[1];
    if (!key) continue;
    const raw = (m[2] ?? "").trim();
    if (raw.startsWith('"') && raw.endsWith('"')) out[key] = raw.slice(1, -1).replace(/\\"/g, '"');
    else if (raw === "true") out[key] = true;
    else if (raw === "false") out[key] = false;
    else if (raw !== "" && Number.isFinite(Number(raw))) out[key] = Number(raw);
    else out[key] = raw;
  }
  return out;
}

interface MdSerializerState {
  write: (text: string) => void;
}

// The stock Mention node, extended to carry `params` and to serialise back to `@id(params)` for
// tiptap-markdown so the stored persona stays human-reviewable with no hidden encoding.
export const PersonaMention = Mention.extend({
  addAttributes() {
    const parent = this.parent?.() ?? {};
    return {
      ...parent,
      params: {
        default: {} as MentionParams,
        parseHTML: (el: HTMLElement): MentionParams => {
          try {
            return JSON.parse(el.getAttribute("data-params") || "{}") as MentionParams;
          } catch {
            return {};
          }
        },
        renderHTML: (attrs: { params?: MentionParams }) =>
          attrs.params && Object.keys(attrs.params).length ? { "data-params": JSON.stringify(attrs.params) } : {},
      },
    };
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: MdSerializerState, node: { attrs: { id?: string | null; params?: MentionParams } }) {
          state.write(`@${node.attrs.id ?? ""}${serializeParams(node.attrs.params)}`);
        },
        parse: {},
      },
    };
  },
});

export function getMarkdown(editor: Editor): string {
  const storage = editor.storage as { markdown?: { getMarkdown?: () => string } };
  return storage.markdown?.getMarkdown?.() ?? "";
}

// After markdown is loaded into the editor, turn each `@tool` (optionally `@tool(params)`) whose name
// is a real tool into a mention chip. Unknown `@words` are left as-is. Applied end-first so earlier
// positions stay valid as we splice.
export function linkifyMentions(editor: Editor, toolNames: Set<string>): void {
  const mentionType = editor.state.schema.nodes["mention"];
  if (!mentionType) return;
  const hits: Array<{ from: number; to: number; id: string; params: MentionParams }> = [];
  editor.state.doc.descendants((node: PMNode, pos: number) => {
    if (!node.isText || !node.text) return;
    MENTION_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MENTION_RE.exec(node.text)) !== null) {
      const id = m[1];
      if (!id || !toolNames.has(id)) continue;
      const params = m[2] ? parseParams(m[2].slice(1, -1)) : {};
      hits.push({ from: pos + m.index, to: pos + m.index + m[0].length, id, params });
    }
  });
  if (hits.length === 0) return;
  let tr = editor.state.tr;
  for (const h of hits.sort((a, b) => b.from - a.from)) {
    tr = tr.replaceWith(h.from, h.to, mentionType.create({ id: h.id, label: h.id, params: h.params }));
  }
  editor.view.dispatch(tr);
}

// The editor's extension set. `suggestion` is supplied by the React layer (it needs ReactRenderer);
// omitting it (e.g. in tests) yields a fully-working editor with no @ popover. The chip renders the
// codified params inline so the author reviews exactly what will run.
export function buildPersonaExtensions(suggestion?: Omit<SuggestionOptions, "editor">): Extensions {
  return [
    StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
    // breaks: render a single newline as a line break so plain-text personas keep their structure.
    Markdown.configure({ html: false, breaks: true, transformPastedText: true, transformCopiedText: true }),
    PersonaMention.configure({
      HTMLAttributes: { class: "persona-mention" },
      deleteTriggerWithBackspace: true,
      renderHTML({ node }) {
        const id = (node.attrs["id"] as string | null) ?? "";
        const params = node.attrs["params"] as MentionParams | undefined;
        return ["span", { class: "persona-mention", "data-mention": id }, `@${id}${serializeParams(params)}`];
      },
      renderText({ node }) {
        return `@${(node.attrs["id"] as string | null) ?? ""}${serializeParams(node.attrs["params"] as MentionParams | undefined)}`;
      },
      ...(suggestion ? { suggestion } : {}),
    }),
  ];
}

// Update the params of the mention node at `pos` (used by the param form).
export function setMentionParams(editor: Editor, pos: number, params: MentionParams): void {
  const node = editor.state.doc.nodeAt(pos);
  if (!node || node.type.name !== "mention") return;
  editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, params }));
}
