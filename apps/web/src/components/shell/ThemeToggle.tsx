// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { Moon, Sun } from "lucide-react";

const STORAGE_KEY = "eidan-theme";

/**
 * Light/dark switch. Flips `data-theme` on <html> (the switch the design
 * tokens key off) and persists it; the no-flash script in the root
 * layout reads it back before first paint.
 */
export function ThemeToggle(): React.ReactElement {
  const [theme, setTheme] = React.useState<"light" | "dark">("light");

  React.useEffect(() => {
    const current =
      document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    setTheme(current);
  }, []);

  const toggle = React.useCallback(() => {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Private mode / storage disabled — the in-memory flip still holds.
      }
      return next;
    });
  }, []);

  return (
    <button
      type="button"
      className="iconbtn"
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      title="Toggle theme"
    >
      {theme === "dark" ? (
        <Sun className="i" aria-hidden />
      ) : (
        <Moon className="i" aria-hidden />
      )}
    </button>
  );
}
