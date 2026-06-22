// SPDX-License-Identifier: AGPL-3.0-or-later
import { notFound } from "next/navigation";

import { ActivityChrome } from "@/components/admin/ActivityChrome";
import { ConversationsPane } from "@/components/admin/ConversationsPane";
import { CursorsPane } from "@/components/admin/CursorsPane";
import { DashboardPane } from "@/components/admin/DashboardPane";
import { JobsBoard } from "@/components/admin/JobsBoard";
import { LivePane } from "@/components/admin/LivePane";
import { LogsPane } from "@/components/admin/LogsPane";
import { NodesPane } from "@/components/admin/NodesPane";
import { RoutinesPane } from "@/components/admin/RoutinesPane";
import { TriggersPane } from "@/components/admin/TriggersPane";

const TAB_COMPONENTS: Record<string, () => React.ReactElement> = {
  dashboard: DashboardPane,
  conversations: ConversationsPane,
  nodes: NodesPane,
  triggers: TriggersPane,
  routines: RoutinesPane,
  jobs: JobsBoard,
  cursors: CursorsPane,
  log: LogsPane,
  live: LivePane,
};

const TAB_ORDER = [
  "dashboard",
  "conversations",
  "nodes",
  "triggers",
  "routines",
  "jobs",
  "cursors",
  "log",
  "live",
] as const;

/**
 * Tab router for `/admin/activity/[tab]` (docs/014 §3 admin row).
 *
 * The three tabs are siblings rather than separate routes because
 * the chrome banner ("X nodes online · Y conversations active")
 * polls the same backend regardless of which tab is in front, and
 * a chrome over-fetch is cheap. Unknown tab slugs fall through to
 * a 404 — there is no "default-to-conversations on bad input"
 * behaviour, the only canonical entry point is the redirect from
 * `/admin/activity` itself.
 */
export default async function AdminActivityTab({
  params,
}: {
  params: Promise<{ tab: string }>;
}): Promise<React.ReactElement> {
  const { tab } = await params;
  const Pane = TAB_COMPONENTS[tab];
  if (!Pane) notFound();
  return (
    <ActivityChrome activeTab={tab as (typeof TAB_ORDER)[number]}>
      <Pane />
    </ActivityChrome>
  );
}

export function generateStaticParams(): { tab: string }[] {
  return TAB_ORDER.map((tab) => ({ tab }));
}
