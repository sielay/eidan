// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  AlertCircle,
  BarChart3,
  Briefcase,
  BookOpen,
  Calendar,
  ChevronRight,
  Clock,
  Database,
  FileText,
  FolderOpen,
  Grid3x3,
  Inbox,
  Lightbulb,
  Link as LinkIcon,
  ListChecks,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Moon,
  Plus,
  Puzzle,
  Receipt,
  Search,
  Shield,
  Settings,
  Share2,
  ScrollText,
  Sun,
  Zap,
  type LucideIcon,
} from "lucide-react";

export const MAP = {
  chat: MessageSquare,
  memory: BookOpen,
  inbox: Inbox,
  agents: Zap,
  boards: Grid3x3,
  escalations: AlertCircle,
  skills: Lightbulb,
  calendar: Calendar,
  jobs: Clock,
  procedures: ListChecks,
  ventures: Briefcase,
  "decision-log": FileText,
  files: FolderOpen,
  plugins: Puzzle,
  admin: Shield,
  settings: Settings,
  more: MoreHorizontal,
  plus: Plus,
  search: Search,
  sun: Sun,
  moon: Moon,
  chevron: ChevronRight,
  // Integration icons
  mail: Mail,
  database: Database,
  link: LinkIcon,
  share: Share2,
  social: Share2,
  "scroll-text": ScrollText,
  receipt: Receipt,
  analytics: BarChart3,
} as const satisfies Record<string, LucideIcon>;

export type NavIconKey = keyof typeof MAP;

/**
 * Stroke line icon for the shell, sized + coloured by the `.i` design
 * class (CSS width/height + `stroke: currentColor`, so active-nav state
 * recolours it). Lucide's intrinsic 24px is overridden by `.i`.
 */
export function NavIcon({
  name,
  className = "i",
}: {
  name: string;
  className?: string;
}): React.ReactElement {
  const Cmp = MAP[name as NavIconKey] || AlertCircle;
  if (!MAP[name as NavIconKey]) {
    console.error(`[NavIcon] Missing icon mapping for key: "${name}"`);
  }
  return <Cmp className={className} aria-hidden />;
}
