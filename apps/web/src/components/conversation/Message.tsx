// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, GitFork } from "lucide-react";

import { formatAbsolute, formatRelative } from "@/lib/format-time";
import { cn } from "@/lib/utils";

import { ChartBlock } from "./ChartBlock";
import { MermaidBlock } from "./MermaidBlock";
import { MentionAnchor } from "./MentionChip";
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
  /** ⑂ Compare: the candidate models' raw answers, shown in a disclosure below the merged answer. */
  fork?: { legs: Array<{ model: string; text: string; truncated?: boolean; inputTokens?: number; outputTokens?: number }> };
  /** "Second opinion": when provided (latest assistant reply only), shows a button that re-runs the
   *  Inner voice skill to critique + sharpen this answer. Opt-in — the skill no longer auto-fires. */
  onSecondOpinion?: (() => void) | undefined;
  /** Disable the second-opinion button while a turn is in flight. */
  secondOpinionBusy?: boolean | undefined;
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
  fork,
  onSecondOpinion,
  secondOpinionBusy,
}: MessageBlockProps): React.ReactElement {
  const hasBody = content !== null && content.length > 0;
  const hasToolCalls = toolCalls !== undefined && toolCalls.length > 0;

  if (role === "user") {
    return (
      <div className="bubble bubble--user" data-role="user">
        {/* Render the prompt as markdown too (same as assistant replies), so formatting and @-mention
            chips show in both bubble types. Empty content can't happen for a user row, but guard anyway. */}
        {hasBody ? <MarkdownBody content={content ?? ""} /> : <span className="whitespace-pre-wrap">{content}</span>}
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
      {fork && fork.legs.length ? <ForkDisclosure legs={fork.legs} /> : null}
      {onSecondOpinion && hasBody && !streaming ? (
        <button
          type="button"
          onClick={onSecondOpinion}
          disabled={secondOpinionBusy}
          title="A different-lineage model critiques and sharpens this answer (Inner voice)"
          className="mt-1.5 inline-flex items-center gap-1.5 self-start rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <span aria-hidden>◎</span>
          Second opinion
        </button>
      ) : null}
    </div>
  );
}

// ⑂ Compare: a collapsible showing each candidate model's raw answer (the merged answer is the bubble
// above). Persisted on the assistant message's metadata.fork by the engine when a Compare turn runs.
// Shows token usage and truncation status per model.
function ForkDisclosure({ legs }: { legs: Array<{ model: string; text: string; truncated?: boolean; inputTokens?: number; outputTokens?: number }> }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [shown, setShown] = React.useState<number>(0);
  const shownLeg = shown >= 0 && shown < legs.length ? legs[shown] : undefined;
  return (
    <div className="mt-1.5 rounded-md border border-border bg-background/50 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-muted-foreground hover:text-foreground"
      >
        <GitFork className="h-3 w-3" />
        <span className="font-medium">⑂ Compared {legs.length} models</span>
        <span className="text-[10px] text-muted-foreground/70">— see each raw answer</span>
        <ChevronDown className={cn("ml-auto h-3 w-3 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="border-t border-border">
          <div className="flex flex-wrap gap-1 px-2.5 py-1.5">
            {legs.map((l, i) => (
              <button
                key={`${l.model}-${i}`}
                type="button"
                onClick={() => setShown(i)}
                className={cn(
                  "rounded px-2 py-0.5 font-mono text-[10px]",
                  i === shown ? "bg-accent text-accent-foreground" : "bg-muted/60 text-muted-foreground hover:bg-accent/60",
                )}
              >
                {l.model}
                {l.truncated ? <span className="ml-1 text-[9px] opacity-70">⚠ truncated</span> : null}
              </button>
            ))}
          </div>
          {shownLeg && (
            <div className="border-t border-border px-2.5 py-2">
              {(shownLeg.inputTokens !== undefined || shownLeg.outputTokens !== undefined) && (
                <div className="mb-2 text-[10px] text-muted-foreground">
                  {shownLeg.inputTokens !== undefined && <span>in: {shownLeg.inputTokens} </span>}
                  {shownLeg.outputTokens !== undefined && <span>out: {shownLeg.outputTokens}</span>}
                  {shownLeg.truncated && <span className="ml-1 text-alert">⚠ response truncated</span>}
                </div>
              )}
              <div className="max-h-80 overflow-y-auto">
                <MarkdownBody content={shownLeg.text ?? ""} />
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function MarkdownBody({ content }: { content: string }): React.ReactElement {
  return (
    <div
      className={cn(
        // Generous reading rhythm: more vertical air between paragraphs, list items and around
        // headings so dense agent answers stay scannable. Tables get roomy cells, a quiet header
        // band and zebra rows (the scroll wrapper is the `table` component override below).
        "max-w-none leading-relaxed",
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        "[&_p]:my-4",
        "[&_h1]:mt-6 [&_h1]:mb-3 [&_h1]:text-base [&_h1]:font-semibold",
        "[&_h2]:mt-6 [&_h2]:mb-2.5 [&_h2]:text-sm [&_h2]:font-semibold",
        "[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-sm [&_h3]:font-semibold",
        "[&_ul]:my-4 [&_ul]:list-disc [&_ul]:pl-5",
        "[&_ol]:my-4 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_li]:my-1.5",
        "[&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:text-xs",
        "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:text-[0.9em]",
        "[&_a]:underline [&_a]:underline-offset-2",
        "[&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:italic",
        "[&_table]:w-full [&_table]:border-collapse [&_table]:text-[0.95em]",
        "[&_th]:border [&_th]:border-border [&_th]:bg-muted/40 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold",
        "[&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_td]:align-top",
        "[&_tbody_tr:nth-child(even)]:bg-muted/20",
        "[&_hr]:my-5 [&_hr]:border-border",
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => { void node; return <MentionAnchor {...props} />; },
          // Wrap tables so a wide one scrolls horizontally inside the bubble instead of stretching it.
          table: ({ node, ...props }) => { void node; return <div className="my-4 overflow-x-auto"><table {...props} /></div>; },
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
