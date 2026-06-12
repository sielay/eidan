// SPDX-License-Identifier: AGPL-3.0-or-later
//
// eidan control primitives (design brief §3) — the shared design-system controls
// that core screens AND paid bundles build their scoped dashboards from. The CSS
// lives in globals.css; these are the typed React wrappers. Bundles import from
// `@/components/ui` (vendored into apps/web at deploy time).
//
//   import { Card, StatTile, TrendChart, LogList, LogRow, ZonePill,
//            SegmentedControl, ScopeSwitcher, ProgressRing, EmptyState,
//            Skeleton, QuickAddSheet, Sheet, useToast } from "@/components/ui";

export { cx, type Zone } from "./cx";
export { Card } from "./Card";
export { StatTile, Delta } from "./StatTile";
export { ZonePill } from "./ZonePill";
export { SegmentedControl } from "./SegmentedControl";
export { LogList, LogRow } from "./LogList";
export { ProgressRing } from "./ProgressRing";
export { EmptyState } from "./EmptyState";
export { Skeleton } from "./Skeleton";
export { TrendChart, type TrendSeries } from "./TrendChart";
export { ToastProvider, useToast } from "./Toast";
export { Sheet, QuickAddSheet } from "./Sheet";
export { ScopeSwitcher } from "./ScopeSwitcher";
export { Button } from "./button";
