// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Auth layout (`docs/014 §2`).
 *
 * Deliberately renders no nav chrome — the operator cannot navigate elsewhere
 * without an authenticated session. The auth screens (e.g. the Login design)
 * own their own full-viewport layout (`.onb-page`), so this is a pass-through.
 */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return <>{children}</>;
}
