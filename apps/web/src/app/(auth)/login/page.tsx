// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import {
  Mail,
  Shield,
  Check,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
} from "lucide-react";

import { useAuth } from "@/components/providers/auth-provider";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { requestMagicLink, verifyMagicLink, refreshAccessToken } from "@/lib/auth";

/**
 * Magic-link sign-in — implements the Login.html design (Claude Design handoff)
 * wired to the real `/api/auth/*` flow. Five calm stages, one clear action each:
 *
 *   enter → sending → sent → verifying → done
 *
 * No password. The "sent" stage surfaces the dev magic-link + code when the
 * backend runs log-only delivery (EIDAN_DEV_AUTH); in production the operator
 * clicks the emailed link, which lands on `/login?token=…` and auto-verifies.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESEND_SECONDS = 30;

type Stage = "enter" | "sending" | "sent" | "verifying" | "done";

// Where to go after a successful sign-in: an optional ?next= relative path (e.g. the Telegram link
// page), validated to a same-origin path to avoid open redirects; defaults to the app root.
function safeNext(): string {
  try {
    const n = new URL(window.location.href).searchParams.get("next");
    if (n && n.startsWith("/") && !n.startsWith("//")) return n;
  } catch {
    /* ignore */
  }
  return "/";
}

function LoginMark(): React.ReactElement {
  return (
    <span className="onb-mark login-mark">
      <BookOpen className="i" aria-hidden />
    </span>
  );
}

function Spinner({ cls = "" }: { cls?: string }): React.ReactElement {
  return <span className={"login-spin " + cls} aria-hidden />;
}

function ComfortToggle(): React.ReactElement {
  const [relaxed, setRelaxed] = React.useState(false);
  return (
    <button
      type="button"
      className="iconbtn"
      aria-pressed={relaxed}
      onClick={() => {
        const next = !relaxed;
        setRelaxed(next);
        document.documentElement.setAttribute(
          "data-comfort",
          next ? "relaxed" : "default",
        );
      }}
    >
      Relaxed
    </button>
  );
}

function Page({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="onb-page">
      <div className="onb-toolbar">
        <ComfortToggle />
        <ThemeToggle />
      </div>
      <div className="login-shell">{children}</div>
      <div className="onb-footnote">
        <Shield className="i i-sm" aria-hidden />
        Self-hosted · your data stays on your server
      </div>
    </div>
  );
}

export default function LoginPage(): React.ReactElement {
  const { configError } = useAuth();

  const [stage, setStage] = React.useState<Stage>("enter");
  const [email, setEmail] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const [cooldown, setCooldown] = React.useState(0);
  const [devLink, setDevLink] = React.useState<string | null>(null);
  const [devCode, setDevCode] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const valid = EMAIL_RE.test(email.trim());
  const showError = touched && email.trim() !== "" && !valid;

  React.useEffect(() => {
    if (stage === "enter") inputRef.current?.focus();
  }, [stage]);

  // resend cooldown ticker
  React.useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const runVerify = React.useCallback(
    async (args: { token?: string; code?: string }): Promise<void> => {
      setError(null);
      setStage("verifying");
      try {
        await verifyMagicLink(args);
        setStage("done");
        setTimeout(() => window.location.assign(safeNext()), 700);
      } catch (e) {
        setStage("sent");
        setError(e instanceof Error ? e.message : "Could not verify — try again.");
      }
    },
    [],
  );

  // "I've clicked the link" in production (no dev code): the email link may have been opened in
  // another tab/device, setting the refresh cookie — pick it up rather than leaving a dead button.
  const recheck = React.useCallback(async (): Promise<void> => {
    setError(null);
    setStage("verifying");
    const slot = await refreshAccessToken();
    if (slot) {
      setStage("done");
      setTimeout(() => window.location.assign(safeNext()), 500);
    } else {
      setStage("sent");
      setError("We haven't seen the sign-in yet — open the link in your email.");
    }
  }, []);

  // Email-link landing: /login?token=… → auto-verify.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const token = url.searchParams.get("token");
    if (!token) return;
    url.searchParams.delete("token");
    window.history.replaceState({}, "", url.toString());
    void runVerify({ token });
  }, [runVerify]);

  async function send(e?: React.FormEvent): Promise<void> {
    if (e) e.preventDefault();
    setTouched(true);
    setError(null);
    if (!valid) {
      inputRef.current?.focus();
      return;
    }
    setStage("sending");
    try {
      const res = await requestMagicLink(email.trim());
      setDevLink(res.magic_link ?? null);
      setDevCode(res.code ?? null);
      setStage("sent");
      setCooldown(RESEND_SECONDS);
    } catch (err) {
      setStage("enter");
      setError(err instanceof Error ? err.message : "Could not send the link.");
    }
  }

  async function resend(): Promise<void> {
    if (cooldown > 0) return;
    setCooldown(RESEND_SECONDS);
    setError(null);
    try {
      const res = await requestMagicLink(email.trim());
      setDevLink(res.magic_link ?? null);
      setDevCode(res.code ?? null);
    } catch {
      // keep the cooldown; the next explicit action surfaces any error
    }
  }

  function restart(): void {
    setStage("enter");
    setTouched(false);
    setCooldown(0);
    setError(null);
    setDevLink(null);
    setDevCode(null);
  }

  // Backend /api/auth/config unreachable — keep the user oriented inside the same shell.
  if (configError) {
    return (
      <Page>
        <div className="onb-card onb-center login-card">
          <LoginMark />
          <h1 className="onb-title">Can&apos;t reach the server</h1>
          <p className="onb-lede">
            The backend didn&apos;t return <code>/api/auth/config</code>. Check the host
            is running and <code>NEXT_PUBLIC_EIDAN_BACKEND_URL</code> points at it.
          </p>
          <p className="onb-fine">{configError}</p>
        </div>
      </Page>
    );
  }

  if (stage === "enter" || stage === "sending") {
    const sending = stage === "sending";
    return (
      <Page>
        <div className="onb-card onb-center login-card">
          <LoginMark />
          <h1 className="onb-title">Sign in to eidan</h1>
          <p className="onb-lede">
            No password to remember. Enter your email and we&apos;ll send a one-time
            sign-in link.
          </p>
          <form className="login-form" onSubmit={send} noValidate>
            <div className="field onb-field" style={{ marginBottom: 0 }}>
              <label className="field__label" htmlFor="login-email">
                Email
              </label>
              <div className={"input login-input" + (showError ? " is-error" : "")}>
                <Mail className="i i-sm login-input__ic" aria-hidden />
                <input
                  ref={inputRef}
                  id="login-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  disabled={sending}
                  aria-invalid={showError}
                  aria-describedby={showError ? "login-email-err" : undefined}
                  onChange={(ev) => setEmail(ev.target.value)}
                  onBlur={() => setTouched(true)}
                />
              </div>
              <span
                id="login-email-err"
                className={"login-err" + (showError ? " is-on" : "")}
                role={showError ? "alert" : undefined}
              >
                {showError && (
                  <>
                    <AlertTriangle className="i i-sm" aria-hidden />
                    Enter a valid email address
                  </>
                )}
              </span>
            </div>
            <button
              type="submit"
              className="btn btn--primary btn--block btn--lg"
              disabled={sending}
              aria-busy={sending}
            >
              {sending ? (
                <>
                  <Spinner />
                  Sending…
                </>
              ) : (
                <>
                  <Mail className="i i-sm" aria-hidden />
                  Send magic link
                </>
              )}
            </button>
            {error && (
              <span className="login-err is-on" role="alert">
                <AlertTriangle className="i i-sm" aria-hidden />
                {error}
              </span>
            )}
          </form>
          <p className="onb-fine login-shield">
            <Shield className="i i-sm" aria-hidden />
            Self-hosted on your own server. Your data never leaves it.
          </p>
        </div>
      </Page>
    );
  }

  if (stage === "sent") {
    return (
      <Page>
        <div className="onb-card onb-center login-card">
          <div className="onb-sent login-sent">
            <Mail className="i" aria-hidden />
          </div>
          <h1 className="onb-title">Check your inbox</h1>
          <p className="onb-lede">
            We sent a sign-in link to{" "}
            <strong className="login-emailref">{email.trim()}</strong>. Open it on this
            device to continue — it expires in 15 minutes.
          </p>
          {(devLink || devCode) && (
            <div className="login-dev">
              <p className="login-dev__h">Dev mode · email delivery is log-only</p>
              {devLink && (
                <a className="login-dev__link" href={devLink}>
                  Open the sign-in link
                </a>
              )}
              {devCode && (
                <p>
                  or use code <code className="num">{devCode}</code>
                </p>
              )}
            </div>
          )}
          <div className="login-actions">
            <button
              className="btn btn--primary btn--block btn--lg"
              onClick={() => void (devCode ? runVerify({ code: devCode }) : recheck())}
            >
              I&apos;ve clicked the link
              <ArrowRight className="i i-sm" aria-hidden />
            </button>
            <button
              className="btn btn--ghost btn--block"
              onClick={resend}
              disabled={cooldown > 0}
            >
              {cooldown > 0 ? (
                <span className="num">Resend in {cooldown}s</span>
              ) : (
                "Resend link"
              )}
            </button>
          </div>
          {error && (
            <span className="login-err is-on" role="alert">
              <AlertTriangle className="i i-sm" aria-hidden />
              {error}
            </span>
          )}
          <button className="btn btn--quiet login-back" onClick={restart}>
            <ArrowLeft className="i i-sm" aria-hidden />
            Use a different email
          </button>
          <p className="onb-fine login-tip">
            Can&apos;t find it? Check spam, or your server&apos;s mail logs.
          </p>
        </div>
      </Page>
    );
  }

  if (stage === "verifying") {
    return (
      <Page>
        <div className="onb-card onb-center login-card">
          <div className="onb-sent login-sent login-sent--busy">
            <Spinner cls="login-spin--lg" />
          </div>
          <h1 className="onb-title">Signing you in</h1>
          <p className="onb-lede">Verifying your link and opening your workspace…</p>
        </div>
      </Page>
    );
  }

  // done
  return (
    <Page>
      <div className="onb-card onb-center login-card">
        <div className="onb-sent login-sent login-sent--good">
          <Check className="i" aria-hidden />
        </div>
        <h1 className="onb-title">You&apos;re in</h1>
        <p className="onb-lede">
          Signed in as <strong className="login-emailref">{email.trim()}</strong>. Taking
          you to eidan…
        </p>
      </div>
    </Page>
  );
}
