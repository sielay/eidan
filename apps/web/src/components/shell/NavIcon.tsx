// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Activity,
  BookOpen,
  ChevronRight,
  Inbox,
  MessageSquare,
  MoreHorizontal,
  Moon,
  Plus,
  Puzzle,
  Search,
  Settings,
  Sun,
  type LucideIcon,
} from "lucide-react";

import type { NavIconKey } from "@/lib/shell/nav";

const MAP: Record<NavIconKey, LucideIcon> = {
  chat: MessageSquare,
  memory: BookOpen,
  inbox: Inbox,
  plugins: Puzzle,
  admin: Activity,
  settings: Settings,
  more: MoreHorizontal,
  plus: Plus,
  search: Search,
  sun: Sun,
  moon: Moon,
  chevron: ChevronRight,
};

/**
 * Stroke line icon for the shell, sized + coloured by the `.i` design
 * class (CSS width/height + `stroke: currentColor`, so active-nav state
 * recolours it). Lucide's intrinsic 24px is overridden by `.i`.
 */
export function NavIcon({
  name,
  className = "i",
}: {
  name: NavIconKey;
  className?: string;
}): React.ReactElement {
  const Cmp = MAP[name] ?? MessageSquare;
  return <Cmp className={className} aria-hidden />;
}
