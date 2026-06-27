// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

// Standalone Planner — boards with no context scope (personal/cross-cutting). Uses the shared
// BoardsPanel (also embedded in the Ventures screen scoped to a venture, and later Charlotte).

import * as React from "react";

import { BoardsPanel } from "@/plugins/_shared/BoardsPanel";

export default function Boards(): React.ReactElement {
  return (
    <div style={{ padding: "var(--s5)", maxWidth: 980, margin: "0 auto" }}>
      <h2 style={{ fontSize: "var(--fs-20)" }}>Planner</h2>
      <p className="screen-sub" style={{ marginTop: 0 }}>
        Standalone boards — plan anything; cards can link to assets, ventures, jobs and agents, and carry their own activity log.
      </p>
      <BoardsPanel basePath="/p/boards" />
    </div>
  );
}
