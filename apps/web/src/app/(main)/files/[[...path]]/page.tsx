// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { WorkspaceFiles } from "@/components/files/WorkspaceFiles";

/**
 * Files — the unified file explorer over the virtual filesystem (DB-backed, plus
 * Supabase/S3 offload and a live Google Drive mount). The current folder lives in
 * the URL path (/files/<folder>/<sub>), so it's a `[[...path]]` catch-all; the
 * client explorer reads the path and resolves it.
 */
export default function FilesPage(): React.ReactElement {
  return (
    <div className="flex flex-col gap-4 px-4 py-6 lg:px-6">
      <div className="screen-head">
        <div>
          <h1 className="screen-title">Files</h1>
          <div className="screen-sub">Files you and the agent have created</div>
        </div>
      </div>
      <WorkspaceFiles />
    </div>
  );
}
