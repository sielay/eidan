// SPDX-License-Identifier: AGPL-3.0-or-later
import { MemoryScreen } from "@/components/memory/MemoryScreen";

/**
 * Memory (`/memory`) — Notes · Events · Knowledge browser
 * (UI_DESIGN_BRIEF §7, Core). The legacy `/knowledge` route stays
 * reachable until the Knowledge tab is wired to `GET /api/knowledge`.
 */
export default function MemoryPage(): React.ReactElement {
  return <MemoryScreen />;
}
