// SPDX-License-Identifier: AGPL-3.0-or-later
import { AppShell } from "@/components/shell/AppShell";
import { CommandPalette } from "@/components/shell/CommandPalette";
import { AuthGate } from "@/components/providers/auth-gate";

/**
 * The authenticated app's layout (`docs/014 §2`).
 *
 * The responsive {@link AppShell} owns the chrome: a desktop left rail
 * and a mobile bottom bar, both derived from the installed-bundle nav
 * model (UI_DESIGN_BRIEF §4). The global Cmd-K command palette mounts at
 * the layout root so it's reachable from any page (`docs/014 §7`).
 */
export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <AuthGate>
      <AppShell>{children}</AppShell>
      <CommandPalette />
    </AuthGate>
  );
}
