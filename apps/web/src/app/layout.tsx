// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Metadata } from "next";
import { IBM_Plex_Mono, Lexend } from "next/font/google";

import { AuthProvider } from "@/components/providers/auth-provider";

import "./globals.css";

// Lexend (UI) + IBM Plex Mono (numerals/data) per the design system.
// Exposed as CSS variables the eidan tokens reference (`--font-ui`,
// `--font-num`).
const ui = Lexend({
  subsets: ["latin"],
  variable: "--font-lexend",
  display: "swap",
});
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "eidan",
  description: "Self-hosted personal agent host.",
};

// Resolve the persisted theme before first paint so dark mode never
// flashes. Mirrors the `data-theme` switch the design tokens key off.
const themeScript = `(function(){try{var t=localStorage.getItem("eidan-theme");if(!t){t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme="light";}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <html
      lang="en-GB"
      data-theme="light"
      className={`${ui.variable} ${mono.variable} h-full`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="h-full" suppressHydrationWarning>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
