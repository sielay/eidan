// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { buildPersonaExtensions, linkifyMentions, getMarkdown } from "./persona-tiptap";

function makeEditor(content = ""): Editor {
  return new Editor({ extensions: buildPersonaExtensions(), content });
}

function countMentions(editor: Editor): number {
  let n = 0;
  editor.state.doc.descendants((node: PMNode) => {
    if (node.type.name === "mention") n += 1;
  });
  return n;
}

describe("persona-tiptap markdown round-trip", () => {
  it("linkifies a known @tool into a chip and serialises it back to @tool", () => {
    const editor = makeEditor("Recall prior notes with @decision_search and ignore @notatool here.");
    linkifyMentions(editor, new Set(["decision_search"]));

    expect(countMentions(editor)).toBe(1); // only the known tool becomes a chip
    const md = getMarkdown(editor);
    expect(md).toContain("@decision_search"); // chip serialises back to plain @name
    expect(md).toContain("@notatool"); // unknown @word stays plain text
    editor.destroy();
  });

  it("preserves markdown structure (headings/lists) alongside mentions", () => {
    const editor = makeEditor("# Daily\n\n- check mail with @imap_search\n- record findings with @decision_record");
    linkifyMentions(editor, new Set(["imap_search", "decision_record"]));

    expect(countMentions(editor)).toBe(2);
    const md = getMarkdown(editor);
    expect(md).toContain("@imap_search");
    expect(md).toContain("@decision_record");
    expect(md).toMatch(/^#\s+Daily/m); // heading survives
    expect(md).toMatch(/[-*]\s/); // list survives
    editor.destroy();
  });

  it("round-trips codified params: @tool(arg=value) -> chip -> @tool(arg=value)", () => {
    const editor = makeEditor('Resume with @job_cursor(action=get, job="thinker") then post.');
    linkifyMentions(editor, new Set(["job_cursor"]));

    expect(countMentions(editor)).toBe(1);
    let attrs: Record<string, unknown> = {};
    editor.state.doc.descendants((node: PMNode) => {
      if (node.type.name === "mention") attrs = node.attrs as Record<string, unknown>;
    });
    expect(attrs["id"]).toBe("job_cursor");
    expect(attrs["params"]).toEqual({ action: "get", job: "thinker" });

    const md = getMarkdown(editor);
    expect(md).toContain("@job_cursor(action=get, job=thinker)");
    editor.destroy();
  });

  it("leaves a tool-free persona as plain markdown", () => {
    const editor = makeEditor("Summarise my unread mail and flag errors.");
    expect(countMentions(editor)).toBe(0);
    expect(getMarkdown(editor)).toContain("Summarise my unread mail");
    editor.destroy();
  });
});
