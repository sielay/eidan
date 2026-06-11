// SPDX-License-Identifier: AGPL-3.0-or-later
import { OnboardingFlow } from "@/components/onboarding/OnboardingFlow";

/**
 * First-run onboarding (`/onboarding`). Top-level route — no app shell,
 * no auth-centering — so the wizard owns the full viewport and scrolls
 * naturally on mobile (UI_DESIGN_BRIEF §7).
 */
export default function OnboardingPage(): React.ReactElement {
  return (
    <div className="app-scroll" style={{ height: "100%", background: "var(--bg)" }}>
      <OnboardingFlow />
    </div>
  );
}
