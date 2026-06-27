// SPDX-License-Identifier: AGPL-3.0-or-later
import { notFound } from "next/navigation";

import { ActivityChrome } from "@/components/admin/ActivityChrome";
import { DashboardPane } from "@/components/admin/DashboardPane";
import { LogsPane } from "@/components/admin/LogsPane";
import { NodesPane } from "@/components/admin/NodesPane";
import { UsagePane } from "@/components/admin/UsagePane";

// Admin is intentionally lean: conversations have their own surface (/c/…); jobs have theirs (/jobs);
// triggers/routines were retired into agents (eidan.agent_triggers); the cursors pane only ever showed
// data when the gitignored EIDAN_ADMIN_PANELS was set. log + live merged into one streaming, searchable
// "live" view (the LogsPane). Trimmed 2026-06-24.
const TAB_COMPONENTS: Record<string, () => React.ReactElement> = {
  dashboard: DashboardPane,
  nodes: NodesPane,
  usage: UsagePane,
  live: LogsPane,
};

const TAB_ORDER = ["dashboard", "nodes", "usage", "live"] as const;

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
