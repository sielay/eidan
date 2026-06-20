// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import React from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { cn } from "@/lib/utils";
import type { ToolCatalogEntry } from "@/lib/api/admin";
import { buildPersonaExtensions, linkifyMentions } from "./persona-tiptap";

// Read-only render of a stored persona through the SAME TipTap pipeline as the editor, so the preview
// formats identically (headings / lists / bold) and tool refs appear as the same chips — no separate
// markdown renderer to drift out of sync.
export function PersonaView({
  persona,
  tools,
  className,
}: {
  persona: string;
  tools: ToolCatalogEntry[];
  className?: string;
}): React.ReactElement {
  const toolNames = React.useMemo(() => new Set(tools.map((t) => t.name)), [tools]);
  const editor = useEditor(
    {
      immediatelyRender: false,
      editable: false,
      extensions: buildPersonaExtensions(),
      content: persona,
    },
    [persona],
  );

  React.useEffect(() => {
    if (editor) linkifyMentions(editor, toolNames);
  }, [editor, toolNames]);

  return (
    <div className={cn("persona-prose text-xs text-muted-foreground", className)}>
      <EditorContent editor={editor} />
    </div>
  );
}
