// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Lexend } from "next/font/google";

import { AuthProvider } from "@/components/providers/auth-provider";
import { InstallPrompt } from "@/components/pwa/InstallPrompt";
import { ServiceWorkerRegistrar } from "@/components/pwa/ServiceWorkerRegistrar";

import "./globals.css";
// Plugin-contributed stylesheets (empty in base; the deploy assembly fills it).
import "@/plugins/bundles.generated.css";

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
  applicationName: "eidan",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "eidan",
  },
  icons: {
    icon: [
      { url: "/icons/icon.svg", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icons/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    // iOS home-screen icon must be PNG (it ignores SVG apple-touch-icons).
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
};

// The address-bar / standalone chrome colour tracks the theme. The browser
// resolves the matching entry from the user's colour scheme.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FBFBFA" },
    { media: "(prefers-color-scheme: dark)", color: "#1D1D23" },
  ],
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
        <ServiceWorkerRegistrar />
        <AuthProvider>{children}</AuthProvider>
        <InstallPrompt />
      </body>
    </html>
  );
}
