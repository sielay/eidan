// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { JobsBoard } from "@/components/admin/JobsBoard";

/**
 * Top-level Jobs surface — the delegation work queue (`eidan.jobs`) as a
 * kanban board, promoted to the sidebar so it's a first-class view rather
 * than an admin/activity tab. The board owns its own loading/empty/error
 * states and the per-job detail drawer.
 */
export default function JobsPage(): React.ReactElement {
  // Full-bleed (not the 760px `.content` column) — the kanban wants the width.
  return (
    <div className="flex flex-col gap-4 px-4 py-6 lg:px-6">
      <div className="screen-head">
        <div>
          <h1 className="screen-title">Jobs</h1>
          <div className="screen-sub">The delegation work queue</div>
        </div>
      </div>
      <JobsBoard />
    </div>
  );
}
