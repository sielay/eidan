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
  return (
    <div className="content">
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
