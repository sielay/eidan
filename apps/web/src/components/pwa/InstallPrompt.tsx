// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { Download, X } from "lucide-react";

// The `beforeinstallprompt` event isn't in the DOM lib typings.
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  prompt: () => Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "eidan-pwa-install-dismissed";

/**
 * A subtle "Install app" affordance.
 *
 * Browsers fire `beforeinstallprompt` only when the app is installable (valid
 * manifest + SW + not already installed). We stash the event, show a small,
 * dismissible chip, and call `prompt()` on click. If the user dismisses it we
 * remember that (localStorage) and stay out of the way. Already-installed
 * (standalone display-mode) hides it entirely. Browsers without the event
 * (e.g. Safari, which installs via the Share sheet) simply never see the chip.
 */
export function InstallPrompt(): React.ReactElement | null {
  const [deferred, setDeferred] =
    React.useState<BeforeInstallPromptEvent | null>(null);
  const [hidden, setHidden] = React.useState(true);

  React.useEffect(() => {
    if (typeof window === "undefined") return;

    // Already installed → never show.
    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      // iOS Safari
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (standalone) return;

    let dismissed = false;
    try {
      dismissed = localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      /* private mode — treat as not dismissed */
    }
    if (dismissed) return;

    const onPrompt = (e: Event): void => {
      e.preventDefault(); // stop Chrome's default mini-infobar
      setDeferred(e as BeforeInstallPromptEvent);
      setHidden(false);
    };
    const onInstalled = (): void => {
      setHidden(true);
      setDeferred(null);
    };

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = React.useCallback(async () => {
    if (!deferred) return;
    await deferred.prompt();
    try {
      await deferred.userChoice;
    } finally {
      setDeferred(null);
      setHidden(true);
    }
  }, [deferred]);

  const dismiss = React.useCallback(() => {
    setHidden(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
  }, []);

  if (hidden || !deferred) return null;

  return (
    <div
      role="dialog"
      aria-label="Install eidan"
      style={{
        position: "fixed",
        zIndex: 60,
        left: "50%",
        transform: "translateX(-50%)",
        bottom: "max(var(--s4, 16px), env(safe-area-inset-bottom))",
        display: "flex",
        alignItems: "center",
        gap: "var(--s3, 12px)",
        padding: "var(--s2, 8px) var(--s3, 12px)",
        borderRadius: "var(--r-full, 999px)",
        background: "var(--surface, #fff)",
        color: "var(--text, #1D1D23)",
        border: "1px solid var(--border, #E6E6EA)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
        maxWidth: "calc(100vw - 2 * var(--s4, 16px))",
      }}
    >
      <button
        type="button"
        onClick={install}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--s2, 8px)",
          padding: "var(--s2, 8px) var(--s3, 12px)",
          borderRadius: "var(--r-full, 999px)",
          background: "var(--accent, #4F46E5)",
          color: "var(--accent-contrast, #fff)",
          fontWeight: 500,
          fontSize: "var(--fs-15, 0.9375rem)",
          border: "none",
          cursor: "pointer",
        }}
      >
        <Download style={{ width: 16, height: 16 }} aria-hidden />
        Install app
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss install prompt"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 32,
          height: 32,
          borderRadius: "var(--r-full, 999px)",
          background: "transparent",
          color: "var(--muted, #6B6B73)",
          border: "none",
          cursor: "pointer",
        }}
      >
        <X style={{ width: 16, height: 16 }} aria-hidden />
      </button>
    </div>
  );
}
