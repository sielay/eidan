// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

/**
 * Markdown renderer for a knowledge body. Pre-processes ``[[slug]]``
 * wikilinks per `docs/017 §2`: resolved targets become anchor links
 * to the row they point at; unresolved targets render in muted text
 * with a dotted underline and a tooltip per `docs/017 §8.2`.
 *
 * Resolution is purely client-side against ``resolveSlug`` — the
 * caller passes a mapping derived from the already-loaded knowledge
 * index, so wikilink navigation does not cost a round-trip.
 */
export interface KnowledgeMarkdownProps {
  body: string;
  resolveSlug: (slug: string) => { id: string; title: string | null } | null;
  onOpenSlug?: (target: { id: string; slug: string }) => void;
}

const WIKILINK_RE = /\[\[([a-z0-9][a-z0-9/_-]*)\]\]/g;

// remark-gfm normalises text, but it doesn't understand wikilinks.
// Rather than write a full remark plugin, we pre-process the source
// to turn ``[[slug]]`` into a knowledge:// markdown link or, for
// unresolved targets, an inline HTML span that the component map
// catches at render time. The placeholder shape is intentionally
// distinct from anything markdown might emit naturally.
const UNRESOLVED_PREFIX = "knowledge-unresolved://";

function preprocess(
  body: string,
  resolveSlug: KnowledgeMarkdownProps["resolveSlug"],
): string {
  return body.replace(WIKILINK_RE, (_match, slug: string) => {
    const resolved = resolveSlug(slug);
    if (resolved) {
      const label = resolved.title ?? slug;
      return `[${label}](knowledge://${slug})`;
    }
    return `[${slug}](${UNRESOLVED_PREFIX}${slug})`;
  });
}

export function KnowledgeMarkdown({
  body,
  resolveSlug,
  onOpenSlug,
}: KnowledgeMarkdownProps): React.ReactElement {
  const source = React.useMemo(
    () => preprocess(body, resolveSlug),
    [body, resolveSlug],
  );

  return (
    <div className="prose prose-sm max-w-none text-foreground prose-pre:bg-muted prose-code:bg-muted">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, href, children, ...rest }) => {
            void node;
            if (typeof href === "string" && href.startsWith(UNRESOLVED_PREFIX)) {
              const slug = href.slice(UNRESOLVED_PREFIX.length);
              return (
                <span
                  className={cn(
                    "cursor-help text-muted-foreground/80",
                    "underline decoration-dotted decoration-muted-foreground/60",
                    "underline-offset-2",
                  )}
                  title={`Not yet a knowledge entry: ${slug}`}
                  data-knowledge-unresolved={slug}
                >
                  {children}
                </span>
              );
            }
            if (typeof href === "string" && href.startsWith("knowledge://")) {
              const slug = href.slice("knowledge://".length);
              const target = resolveSlug(slug);
              return (
                <a
                  {...rest}
                  href={target ? `#knowledge-${target.id}` : "#"}
                  onClick={(event) => {
                    event.preventDefault();
                    if (target && onOpenSlug) {
                      onOpenSlug({ id: target.id, slug });
                    }
                  }}
                  className="font-medium text-foreground underline decoration-muted-foreground/60 underline-offset-2 hover:decoration-foreground"
                >
                  {children}
                </a>
              );
            }
            return (
              <a
                {...rest}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {children}
              </a>
            );
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
