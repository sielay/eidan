import { CommandPalette } from "@/components/shell/CommandPalette";
import { Header } from "@/components/shell/header";
import { Sidebar } from "@/components/shell/sidebar";

/**
 * The authenticated app's layout (`docs/014 §2`).
 *
 * Two columns: a left sidebar with the conversation list + plugin
 * nav slots, and a main pane with the route's content beneath the
 * global header. The global Cmd-K command palette mounts at the
 * layout root so it's reachable from any page (`docs/014 §7`).
 */
export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex h-full w-full">
      <Sidebar />
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <Header />
        <main className="flex-1 overflow-y-auto bg-background">{children}</main>
      </div>
      <CommandPalette />
    </div>
  );
}
