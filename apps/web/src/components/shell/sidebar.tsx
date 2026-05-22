"use client";

import Link from "next/link";
import { AlertCircle, BookOpen, MessageSquare, Puzzle } from "lucide-react";

import { ConversationList } from "@/components/conversation/ConversationList";
import { PluginList } from "@/components/shell/PluginList";
import { cn } from "@/lib/utils";

/**
 * Layout shell sidebar.
 *
 * Two named slots, per `docs/014 §10`:
 *
 * - `conversation-list` — host renders the recent conversations
 *   (today + recent) here, plus the "new conversation" affordance.
 * - `plugin-nav` — read-only list of the plugins the host loaded at
 *   startup, fetched from ``GET /api/plugins``. Phase 4 plugins will
 *   inject their own sidebar entries (`docs/001 §3.1`'s
 *   `frontend.components[].slot`) alongside this list.
 */
export function Sidebar(): React.ReactElement {
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-muted/30">
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <Link
          href="/"
          className="text-sm font-semibold tracking-tight text-foreground"
        >
          eidan
        </Link>
      </div>

      <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-4">
        <SidebarSection
          icon={<MessageSquare className="h-3.5 w-3.5" />}
          title="Conversations"
        >
          <ConversationList />
        </SidebarSection>

        <SidebarSection
          icon={<BookOpen className="h-3.5 w-3.5" />}
          title="Knowledge"
        >
          <Link
            href="/knowledge"
            className="block rounded-md border border-dashed border-border bg-background/60 px-3 py-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Browse knowledge base →
          </Link>
        </SidebarSection>

        <SidebarSection
          icon={<AlertCircle className="h-3.5 w-3.5" />}
          title="Inbox"
        >
          <Link
            href="/escalations"
            className="block rounded-md border border-dashed border-border bg-background/60 px-3 py-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Open escalations →
          </Link>
        </SidebarSection>

        <SidebarSection
          icon={<Puzzle className="h-3.5 w-3.5" />}
          title="Plugins"
        >
          <PluginList />
        </SidebarSection>
      </div>
    </aside>
  );
}

function SidebarSection({
  icon,
  title,
  children,
  className,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      <h2 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}
