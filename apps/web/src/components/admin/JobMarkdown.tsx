// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Job goals are authored as markdown (headings, lists, code). Tailwind's preflight strips default
// element styling, so map each node to a compact, drawer-sized style. Only `children`/`href` are
// forwarded — never react-markdown's `node` prop — so nothing leaks onto the DOM.
const MD: Components = {
  h1: ({ children }) => <p className="mt-2 mb-1 text-sm font-semibold text-foreground">{children}</p>,
  h2: ({ children }) => <p className="mt-2 mb-1 text-[13px] font-semibold text-foreground">{children}</p>,
  h3: ({ children }) => <p className="mt-1.5 mb-0.5 text-xs font-semibold text-foreground">{children}</p>,
  p: ({ children }) => <p className="my-1 leading-snug">{children}</p>,
  ul: ({ children }) => <ul className="my-1 list-disc pl-4">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal pl-4">{children}</ol>,
  li: ({ children }) => <li className="my-0.5">{children}</li>,
  code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{children}</code>,
  pre: ({ children }) => <pre className="my-1 overflow-x-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-[11px]">{children}</pre>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-700 underline dark:text-blue-400">{children}</a>
  ),
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  blockquote: ({ children }) => <blockquote className="my-1 border-l-2 border-border pl-2 text-muted-foreground">{children}</blockquote>,
};

export function JobMarkdown({ children }: { children: string }): React.ReactElement {
  return (
    <div className="text-sm text-foreground">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD}>{children}</ReactMarkdown>
    </div>
  );
}
