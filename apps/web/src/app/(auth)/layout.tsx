/**
 * Auth layout (`docs/014 §2`).
 *
 * Deliberately renders no nav chrome — the operator cannot navigate
 * elsewhere without an authenticated session. The shell's header and
 * sidebar are reserved for the `(main)` group.
 */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-6">
      {children}
    </div>
  );
}
