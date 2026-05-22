import type { Metadata } from "next";

import { AuthProvider } from "@/components/providers/auth-provider";

import "./globals.css";

export const metadata: Metadata = {
  title: "eidan",
  description: "Self-hosted personal agent host.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <html lang="en-GB" className="h-full">
      <body className="h-full" suppressHydrationWarning>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
