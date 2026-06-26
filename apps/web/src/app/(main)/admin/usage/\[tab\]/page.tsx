// SPDX-License-Identifier: AGPL-3.0-or-later
import { notFound } from "next/navigation";

import { UsageChrome } from "@/components/admin/UsageChrome";
import { UsageOverviewPane } from "@/components/admin/UsageOverviewPane";
import { UsageModelsPane } from "@/components/admin/UsageModelsPane";
import { UsageProvidersPane } from "@/components/admin/UsageProvidersPane";
import { UsageNodesPane } from "@/components/admin/UsageNodesPane";
import { UsageCallsPane } from "@/components/admin/UsageCallsPane";

const TAB_COMPONENTS: Record<string, () => React.ReactElement> = {
  overview: UsageOverviewPane,
  models: UsageModelsPane,
  providers: UsageProvidersPane,
  nodes: UsageNodesPane,
  calls: UsageCallsPane,
};

const TAB_ORDER = ["overview", "models", "providers", "nodes", "calls"] as const;

export default async function AdminUsageTab({
  params,
}: {
  params: Promise<{ tab: string }>;
}): Promise<React.ReactElement> {
  const { tab } = await params;
  const Pane = TAB_COMPONENTS[tab];
  if (!Pane) notFound();
  return (
    <UsageChrome activeTab={tab as (typeof TAB_ORDER)[number]}>
      <Pane />
    </UsageChrome>
  );
}

export function generateStaticParams(): { tab: string }[] {
  return TAB_ORDER.map((tab) => ({ tab }));
}
