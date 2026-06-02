"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

import type { PairedToolCall } from "./Thread";
import { ToolDisclosure } from "./ToolDisclosure";

type MessageRole = "user" | "assistant" | "tool";

export interface MessageBlockProps {
  role: MessageRole;
  /** Null for tool-call-only assistant turns; renders as empty body. */
  content: string | null;
  /** Folded tool calls + paired results (`docs/014 §4.2`). */
  toolCalls?: PairedToolCall[];
  /** Append-only marker shown when a stream was interrupted (`docs/014 §4.6`). */
  interrupted?: boolean;
  /** Streaming chips render a soft pulse on the assistant body. */
  streaming?: boolean;
}

const roleLabel: Record<MessageRole, string> = {
  user: "You",
  assistant: "Assistant",
  tool: "Tool",
};

/**
 * One rendered message row.
 *
 * The shape is one DB row → one block per `docs/014 §4.2`, with one
 * exception: tool rows fold under their issuing assistant via
 * ``toolCalls``, rendered by :class:`ToolDisclosure`. OFFER chips,
 * turn-cost chips, and failure markers are still deferred — the row
 * carries only what the streaming-MVP issue requires plus the §4.2
 * tool disclosure.
 */
export function MessageBlock({
  role,
  content,
  toolCalls,
  interrupted,
  streaming,
}: MessageBlockProps): React.ReactElement {
  const hasBody = content !== null && content.length > 0;
  const hasToolCalls = toolCalls !== undefined && toolCalls.length > 0;
  const tone =
    role === "user"
      ? "border-primary/20 bg-primary/5"
      : role === "tool"
        ? "border-dashed border-border/60 bg-muted/40"
        : "border-border bg-background";

  return (
    <div
      className={cn("rounded-md border px-4 py-3 text-sm", tone)}
      data-role={role}
    >
      <div className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <span>{roleLabel[role]}</span>
        {streaming ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/60" />
            streaming…
          </span>
        ) : null}
        {hasBody && role !== "tool" ? (
          <CopyMessageButton content={content!} role={role} />
        ) : null}
      </div>
      <div className="break-words text-foreground">
        {hasBody &&
          (role === "assistant" ? (
            <MarkdownBody content={content!} />
          ) : (
            <span className="whitespace-pre-wrap">{content}</span>
          ))}
        {!hasBody && !hasToolCalls && (
          <span className="text-xs italic text-muted-foreground">
            (no content)
          </span>
        )}
        {interrupted ? (
          <span className="ml-2 text-xs font-medium text-red-600">
            [interrupted]
          </span>
        ) : null}
        {hasToolCalls && <ToolDisclosure calls={toolCalls!} />}
      </div>
    </div>
  );
}

function CopyMessageButton({
  content,
  role,
}: {
  content: string;
  role: MessageRole;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  // Hold a single reset timer so rapid clicks reuse the slot instead of
  // queueing N flashes that fire after unmount.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const onClick = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard write can fail in insecure contexts or when permission
      // is denied. Silent no-op is the right shape here — the user can
      // still select-and-copy the message body manually.
    }
  }, [content]);

  const label =
    role === "user" ? "Copy prompt" : role === "assistant" ? "Copy response" : "Copy";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      className={cn(
        "ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5",
        "text-[10px] font-medium uppercase tracking-wider",
        "text-muted-foreground/70 hover:text-foreground hover:bg-muted/60",
        "transition-colors",
      )}
    >
      {copied ? (
        <Check className="h-3 w-3" aria-hidden />
      ) : (
        <Copy className="h-3 w-3" aria-hidden />
      )}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
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
        "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
        "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-muted-foreground",
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
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
