"use client";

import * as React from "react";

import { useAuth } from "@/components/providers/auth-provider";
import { requestMagicLink, verifyMagicLink } from "@/lib/auth";

/**
 * Native magic-link login (`docs/011 §14`).
 *
 * The flow:
 *
 *   1. Operator enters their email. Submit → POST /api/auth/magic-link.
 *   2. Backend sends an email with a click-through URL + a 6-digit
 *      code. In dev, the response body also echoes both so the
 *      operator doesn't need Mailpit running.
 *   3. The form switches to "check your email" mode and exposes a
 *      code field for the paste-back path.
 *   4. Clicking the email URL lands on `/login?token=<token>` →
 *      this page auto-verifies and redirects home.
 *   5. Submitting the code → POST /api/auth/verify with `code` →
 *      same redirect on success.
 *
 * No third-party JS. State is local to this component plus the
 * `useAuth()` provider context (which refreshes once a token lands).
 */
export default function LoginPage(): React.ReactElement {
  const { configError } = useAuth();

  const [email, setEmail] = React.useState("");
  const [phase, setPhase] = React.useState<"enter-email" | "await-verify">(
    "enter-email",
  );
  const [code, setCode] = React.useState("");
  const [devMagicLink, setDevMagicLink] = React.useState<string | null>(null);
  const [devCode, setDevCode] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // The login form is intentionally not pre-filled from the backend.
  // `/api/auth/config` is public + unauthenticated and must not
  // leak the operator's pinned email; browser form autofill
  // remembers it after first login.

  // Handle the email-link landing case: /login?token=...
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const token = url.searchParams.get("token");
    if (!token) return;
    (async () => {
      setBusy(true);
      try {
        await verifyMagicLink({ token });
        // Strip the token from the URL so a refresh doesn't replay.
        url.searchParams.delete("token");
        window.history.replaceState({}, "", url.toString());
        window.location.assign("/");
      } catch (err) {
        setError(err instanceof Error ? err.message : "verify failed");
      } finally {
        setBusy(false);
      }
    })();
  }, []);

  async function handleRequestLink(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await requestMagicLink(email);
      setPhase("await-verify");
      if (res.magic_link) setDevMagicLink(res.magic_link);
      if (res.code) setDevCode(res.code);
    } catch (err) {
      setError(err instanceof Error ? err.message : "request failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmitCode(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await verifyMagicLink({ code });
      window.location.assign("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "verify failed");
    } finally {
      setBusy(false);
    }
  }

  if (configError) {
    return (
      <main className="mx-auto mt-16 max-w-md p-6">
        <h1 className="mb-2 text-xl font-semibold">Auth config unavailable</h1>
        <p className="text-sm text-muted-foreground">
          The backend did not return <code>/api/auth/config</code>. Check
          that the host is running and that{" "}
          <code>NEXT_PUBLIC_EIDAN_BACKEND_URL</code> points at it.
        </p>
        <p className="mt-3 text-xs text-muted-foreground">{configError}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto mt-16 max-w-md p-6">
      <h1 className="mb-4 text-2xl font-semibold">Sign in to Eidan</h1>

      {phase === "enter-email" && (
        <form onSubmit={handleRequestLink} className="space-y-4">
          <label className="block text-sm font-medium" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded border border-input bg-background px-3 py-2 text-sm"
            placeholder="you@example.com"
            disabled={busy}
          />
          <button
            type="submit"
            disabled={busy || !email}
            className="w-full rounded bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy ? "Sending…" : "Send magic link"}
          </button>
          <p className="text-xs text-muted-foreground">
            We&apos;ll email you a link. The link expires in 15 minutes.
          </p>
        </form>
      )}

      {phase === "await-verify" && (
        <div className="space-y-6">
          <div className="rounded border border-border bg-muted/40 p-4 text-sm">
            <p className="mb-2 font-medium">Check your email</p>
            <p className="text-muted-foreground">
              We sent a sign-in link to <strong>{email}</strong>. Click the
              link to finish signing in.
            </p>
          </div>

          {devMagicLink && (
            <div className="rounded border border-amber-400/40 bg-amber-50 p-3 text-xs text-amber-900">
              <p className="mb-1 font-medium">
                Dev mode: email delivery is log-only.
              </p>
              <p>
                Open the link directly:{" "}
                <a
                  href={devMagicLink}
                  className="text-amber-900 underline underline-offset-2"
                >
                  {devMagicLink}
                </a>
              </p>
              {devCode && (
                <p className="mt-1">
                  Or paste the code: <code>{devCode}</code>
                </p>
              )}
            </div>
          )}

          <form onSubmit={handleSubmitCode} className="space-y-3">
            <label className="block text-sm font-medium" htmlFor="code">
              Or paste the 6-digit code
            </label>
            <input
              id="code"
              type="text"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-full rounded border border-input bg-background px-3 py-2 text-center text-lg tracking-widest"
              placeholder="000000"
              disabled={busy}
            />
            <button
              type="submit"
              disabled={busy || code.length !== 6}
              className="w-full rounded bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy ? "Verifying…" : "Sign in with code"}
            </button>
          </form>

          <button
            type="button"
            onClick={() => {
              setPhase("enter-email");
              setDevMagicLink(null);
              setDevCode(null);
              setError(null);
            }}
            className="text-xs text-muted-foreground underline underline-offset-2"
          >
            Use a different email
          </button>
        </div>
      )}

      {error && (
        <p className="mt-4 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
