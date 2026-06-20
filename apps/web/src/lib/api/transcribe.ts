// SPDX-License-Identifier: AGPL-3.0-or-later
// Client for the engine's speech-to-text endpoint (@eidandev/transcribe via the catch-all proxy).
import { authFetch } from "@/lib/auth";

// Is server-side transcription configured? The mic button is hidden when not, so voice degrades
// gracefully on deployments without a Whisper endpoint/key.
export async function isTranscribeAvailable(): Promise<boolean> {
  try {
    const res = await authFetch("/api/transcribe", { method: "GET", headers: { Accept: "application/json" } });
    if (!res.ok) return false;
    const body = (await res.json()) as { available?: boolean };
    return body.available === true;
  } catch {
    return false;
  }
}

// Send a recorded audio blob; get back the transcript. The blob's mime (set by MediaRecorder) becomes
// the request content-type so the engine names the file with the right codec extension for Whisper.
export async function transcribeAudio(blob: Blob): Promise<string> {
  const res = await authFetch("/api/transcribe", {
    method: "POST",
    headers: { "Content-Type": blob.type || "audio/webm" },
    body: blob,
  });
  if (!res.ok) throw new Error(`transcription failed (${res.status})`);
  const body = (await res.json()) as { text?: string };
  return (body.text ?? "").trim();
}
