// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { formatAbsolute, formatRelative } from "@/lib/format-time";
import { cn } from "@/lib/utils";

import { ChartBlock } from "./ChartBlock";
import { MermaidBlock } from "./MermaidBlock";
import { ImageBlock } from "./ImageBlock";
import type { PairedToolCall } from "./Thread";
import { ToolDisclosure } from "./ToolDisclosure";

// Pull the fenced-block language ("chart") + raw text out of a <pre>'s hast node so we
// can render a ```chart block as a real chart instead of a code box.
function fencedBlock(node: unknown): { lang?: string; text: string } {
  const code = (node as { children?: Array<{ tagName?: string; properties?: { className?: unknown }; children?: Array<{ value?: string }> }> })
    ?.children?.find((c) => c.tagName === "code");
  const cls = code?.properties?.className;
  const lang = Array.isArray(cls)
    ? (cls.find((c) => typeof c === "string" && c.startsWith("language-")) as string | undefined)?.slice(9)
    : undefined;
  const text = code?.children?.map((c) => c.value ?? "").join("") ?? "";
  return { lang, text };
}

function MsgTime({ iso }: { iso?: string }): React.ReactElement | null {
  if (!iso) return null;
  return (
    <time className="msg-time" dateTime={iso} title={formatAbsolute(iso)}>
      {formatRelative(iso)}
    </time>
  );
}

type MessageRole = "user" | "assistant" | "tool";

export interface MessageBlockProps {
  role: MessageRole;
  /** Null for tool-call-only assistant turns; renders as empty body. */
  content: string | null;
  /** Folded tool calls + paired results (`docs/014 §4.2`). */
  toolCalls?: PairedToolCall[];
  /** Append-only marker shown when a stream was interrupted (`docs/014 §4.6`). */
  interrupted?: boolean;
  /** Streaming rows render a soft caret on the assistant bubble. */
  streaming?: boolean;
  /** ISO timestamp shown subtly under the bubble (omitted for optimistic/streaming rows). */
  time?: string;
}

/**
 * One rendered message row as a chat bubble (UI_DESIGN_BRIEF §6).
 *
 * - **user** → an indigo bubble, right-aligned.
 * - **assistant** → a quiet surface bubble, left-aligned, with markdown.
 *   Tool calls fold beneath it via {@link ToolDisclosure} — the
 *   user-facing surface of the keen-save promise (`docs/014 §4.2`,
 *   `docs/003 §3`).
 * - **tool** (orphan rows) → a muted inline line.
 *
 * Alignment is by `align-self` from the `.bubble--*` classes within the
 * `.thread` flex column; the assistant wrapper stacks bubble + disclosure.
 */
export function MessageBlock({
  role,
  content,
  toolCalls,
  interrupted,
  streaming,
  time,
}: MessageBlockProps): React.ReactElement {
  const hasBody = content !== null && content.length > 0;
  const hasToolCalls = toolCalls !== undefined && toolCalls.length > 0;

  if (role === "user") {
    return (
      <div className="bubble bubble--user" data-role="user">
        <span className="whitespace-pre-wrap">{content}</span>
        <MsgTime iso={time} />
      </div>
    );
  }

  if (role === "tool") {
    return (
      <div className="msg-tool" data-role="tool">
        {hasToolCalls ? (
          <ToolDisclosure calls={toolCalls!} />
        ) : (
          <span className="costchip">tool</span>
        )}
      </div>
    );
  }

  // assistant
  return (
    <div className="msg-asst" data-role="assistant">
      {hasBody ? (
        <div className="bubble bubble--asst">
          <MarkdownBody content={content!} />
          {interrupted ? (
            <span className="ml-2" style={{ color: "var(--alert)", fontSize: "var(--fs-13)" }}>
              [interrupted]
            </span>
          ) : null}
          {streaming ? <span className="stream-caret" aria-hidden /> : null}
          <MsgTime iso={time} />
        </div>
      ) : !hasToolCalls ? (
        <div className="bubble bubble--asst">
          {streaming ? (
            <span className="stream-caret" aria-hidden />
          ) : (
            <span style={{ color: "var(--muted)", fontStyle: "italic" }}>(no content)</span>
          )}
        </div>
      ) : null}
      {hasToolCalls ? <ToolDisclosure calls={toolCalls!} /> : null}
    </div>
  );
}

function MarkdownBody({ content }: { content: string }): React.ReactElement {
  return (
    <div
      className={cn(
        "max-w-none leading-relaxed",
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        "[&_p]:my-2",
        "[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-semibold",
        "[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-sm [&_h2]:font-semibold",
        "[&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:text-sm [&_h3]:font-semibold",
        "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5",
        "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_li]:my-0.5",
        "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:text-xs",
        "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:text-[0.9em]",
        "[&_a]:underline [&_a]:underline-offset-2",
        "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:italic",
        "[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse",
        "[&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium",
        "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1",
        "[&_hr]:my-3 [&_hr]:border-border",
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => {
            void node;
            return <a {...props} target="_blank" rel="noopener noreferrer" />;
          },
          img: ({ node, src, alt }) => {
            void node;
            return <ImageBlock src={src} alt={typeof alt === "string" ? alt : undefined} />;
          },
          pre: ({ node, children, ...props }) => {
            const { lang, text } = fencedBlock(node);
            if (lang === "chart") return <ChartBlock config={text} />;
            if (lang === "mermaid") return <MermaidBlock code={text} />;
            return <pre {...props}>{children}</pre>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
