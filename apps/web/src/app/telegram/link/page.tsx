// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/providers/auth-provider";
import { authFetch } from "@/lib/auth";

// Redeem a Telegram /start link: the bot captured the chat_id and handed the user a one-time token;
// here — signed in — we POST it so the engine binds that chat to this eidan account. The token is
// read from the URL on the client (avoids the useSearchParams Suspense requirement).
type Status = "loading" | "no-token" | "signin" | "linking" | "ok" | "error";

export default function TelegramLinkPage() {
  const { user, loading } = useAuth();
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("token"));
  }, []);

  useEffect(() => {
    if (loading) return;
    if (token === null) {
      setToken("");
      return;
    }
    if (token === "") {
      setStatus("no-token");
      return;
    }
    if (!user) {
      setStatus("signin");
      return;
    }
    if (status !== "loading" && status !== "signin") return;
    setStatus("linking");
    authFetch("/api/me/telegram/link", {
      method: "POST",
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        if (res.ok) {
          setStatus("ok");
          setMessage("Your Telegram is linked. Head back to the chat — I'll reply there and send your routines and notifications.");
          return;
        }
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setStatus("error");
        setMessage(
          body.error === "token invalid or expired"
            ? "That link expired. Send /start to the bot again for a fresh one."
            : `Couldn't link (${res.status}).`,
        );
      })
      .catch(() => {
        setStatus("error");
        setMessage("Network error while linking — please try again.");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, user, token]);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="text-4xl">🔗</div>
      <h1 className="text-xl font-semibold">Link Telegram</h1>

      {(status === "loading" || status === "linking") && (
        <p className="text-sm opacity-70">{status === "linking" ? "Linking…" : "Loading…"}</p>
      )}

      {status === "no-token" && (
        <p className="text-sm opacity-80">
          This page needs a link token. Open Telegram, send <code>/start</code> to the bot, and tap the
          link it replies with.
        </p>
      )}

      {status === "signin" && (
        <>
          <p className="text-sm opacity-80">Sign in to finish linking this Telegram chat to your account.</p>
          <Link
            href={`/login?next=${encodeURIComponent(`/telegram/link?token=${token ?? ""}`)}`}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            Sign in
          </Link>
        </>
      )}

      {status === "ok" && <p className="text-sm text-green-600">✅ {message}</p>}

      {status === "error" && (
        <>
          <p className="text-sm text-red-600">{message}</p>
          <button
            onClick={() => setStatus("loading")}
            className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-black/5"
          >
            Try again
          </button>
        </>
      )}
    </main>
  );
}
