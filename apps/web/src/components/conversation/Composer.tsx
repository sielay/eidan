// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { Check, ChevronDown, Cpu, Loader2, Mic, MoreVertical, Paperclip, Send, Square, X } from "lucide-react";

import { isTranscribeAvailable, transcribeAudio } from "@/lib/api/transcribe";
import type { ProviderOption } from "@/lib/models";

// Mobile menu: collapse attach, record, model picker into a single menu button with popover.
// Opens above the send button to preserve horizontal width for the input field.
function ComposerMoreMenu({
  onAttachClick,
  onMicStart,
  onMicStop,
  provider,
  providers,
  onProviderChange,
  disabled,
  micRecording,
  micBusy,
}: {
  onAttachClick: () => void;
  onMicStart: () => Promise<void>;
  onMicStop: () => void;
  provider: string;
  providers?: ProviderOption[];
  onProviderChange?: (p: string) => void;
  disabled?: boolean;
  micRecording: boolean;
  micBusy: boolean;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const canRecord = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
  const [recordAvailable, setRecordAvailable] = React.useState(false);

  React.useEffect(() => {
    if (!canRecord) return;
    void isTranscribeAvailable().then(setRecordAvailable).catch(() => setRecordAvailable(false));
  }, [canRecord]);

  return (
    <div className="composer__more-wrap">
      <button
        type="button"
        className="iconbtn composer__more-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title="More options"
        onClick={() => setOpen((v) => !v)}
      >
        <MoreVertical className="i" aria-hidden />
      </button>
      {open ? (
        <>
          <button type="button" className="composer__more-backdrop" aria-label="Close menu" onClick={() => setOpen(false)} />
          <div className="composer__more-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              className="composer__more-item"
              aria-label="Attach files"
              title="Attach images or text files"
              disabled={disabled}
              onClick={() => {
                onAttachClick();
                setOpen(false);
              }}
            >
              <Paperclip className="i" aria-hidden />
              <span>Attach</span>
            </button>
            {canRecord && recordAvailable ? (
              <button
                type="button"
                role="menuitem"
                className={"composer__more-item" + (micRecording ? " is-recording" : "")}
                aria-label={micRecording ? "Stop recording" : "Voice input"}
                title={micBusy ? "Transcribing…" : micRecording ? "Stop & transcribe" : "Voice input"}
                disabled={disabled || micBusy}
                onClick={async () => {
                  if (micRecording) {
                    onMicStop();
                  } else {
                    await onMicStart();
                  }
                }}
              >
                {micBusy ? <Loader2 className="i composer__more-item-spin" aria-hidden /> : micRecording ? <Square className="i" aria-hidden /> : <Mic className="i" aria-hidden />}
                <span>{micRecording ? "Stop" : "Record"}</span>
              </button>
            ) : null}
            {onProviderChange && providers && providers.length > 0 ? (
              <ComposerMoreModelMenu provider={provider} providers={providers} onChange={onProviderChange} onClose={() => setOpen(false)} />
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

// Model picker within the more menu.
function ComposerMoreModelMenu({
  provider,
  providers,
  onChange,
  onClose,
}: {
  provider: string;
  providers: ProviderOption[];
  onChange: (p: string) => void;
  onClose: () => void;
}): React.ReactElement {
  const [modelOpen, setModelOpen] = React.useState(false);
  const current = providers.find((p) => p.name === provider);
  const label = provider ? (current?.name ?? provider) : "Default";

  if (modelOpen) {
    return (
      <div className="composer__more-submenu">
        <button
          type="button"
          role="menuitem"
          className="composer__more-item composer__more-back"
          onClick={() => setModelOpen(false)}
        >
          <ChevronDown className="i" style={{ transform: "rotate(90deg)" }} aria-hidden />
          <span>Back</span>
        </button>
        <div className="composer__more-models">
          <button
            type="button"
            role="menuitemradio"
            className="composer__more-model-opt"
            aria-checked={provider === ""}
            onClick={() => {
              onChange("");
              setModelOpen(false);
              onClose();
            }}
          >
            <Check className={"i i-sm composer__more-model-tick" + (provider === "" ? " is-on" : "")} aria-hidden />
            <span>Default</span>
            <span className="composer__more-model-hint">host default</span>
          </button>
          {providers.map((p) => (
            <button
              key={p.name}
              type="button"
              role="menuitemradio"
              className="composer__more-model-opt"
              aria-checked={p.name === provider}
              onClick={() => {
                onChange(p.name);
                setModelOpen(false);
                onClose();
              }}
            >
              <Check className={"i i-sm composer__more-model-tick" + (p.name === provider ? " is-on" : "")} aria-hidden />
              <span>{p.name}</span>
              <span className="composer__more-model-hint">{p.model}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      role="menuitem"
      className="composer__more-item"
      title={current?.model ? `Model: ${current.name} — ${current.model}` : "Model for this conversation"}
      onClick={() => setModelOpen(true)}
    >
      <Cpu className="i" aria-hidden />
      <span>{label}</span>
    </button>
  );
}

// Voice input state and controls (shared between desktop button and mobile menu).
function useMicRecorder(onText: (t: string) => void): {
  available: boolean;
  recording: boolean;
  busy: boolean;
  start: () => Promise<void>;
  stop: () => void;
} {
  const [available, setAvailable] = React.useState(false);
  const [recording, setRecording] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const recRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const streamRef = React.useRef<MediaStream | null>(null);

  const canRecord = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";

  React.useEffect(() => {
    if (!canRecord) return;
    void isTranscribeAvailable().then(setAvailable).catch(() => setAvailable(false));
  }, [canRecord]);

  const stopTracks = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  React.useEffect(() => () => { recRef.current?.stop(); stopTracks(); }, [stopTracks]);

  const start = React.useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "";
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        stopTracks();
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        chunksRef.current = [];
        if (blob.size === 0) return;
        setBusy(true);
        void transcribeAudio(blob).then(onText).catch(() => { /* no text on failure */ }).finally(() => setBusy(false));
      };
      rec.start();
      recRef.current = rec;
      setRecording(true);
    } catch {
      stopTracks();
      setRecording(false);
    }
  }, [onText, stopTracks]);

  const stop = React.useCallback(() => {
    recRef.current?.stop();
    recRef.current = null;
    setRecording(false);
  }, []);

  return { available, recording, busy, start, stop };
}

// Voice input: records via MediaRecorder, sends the clip to the engine's /api/transcribe, and hands
// the transcript back to the composer (which fills the prompt — the user reviews before sending).
// Hidden entirely when the engine has no STT configured or the browser can't record.
function MicButton({
  onText,
  disabled,
  recording,
  busy,
  onStart,
  onStop,
}: {
  onText: (t: string) => void;
  disabled?: boolean;
  recording: boolean;
  busy: boolean;
  onStart: () => Promise<void>;
  onStop: () => void;
}): React.ReactElement | null {
  const canRecord = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
  const [available, setAvailable] = React.useState(false);

  React.useEffect(() => {
    if (!canRecord) return;
    void isTranscribeAvailable().then(setAvailable).catch(() => setAvailable(false));
  }, [canRecord]);

  if (!canRecord || !available) return null;
  return (
    <button
      type="button"
      className={"iconbtn composer__mic" + (recording ? " is-recording" : "")}
      aria-label={recording ? "Stop recording" : "Voice input"}
      title={busy ? "Transcribing…" : recording ? "Stop & transcribe" : "Voice input"}
      disabled={disabled || busy}
      onClick={() => { if (recording) onStop(); else void onStart(); }}
    >
      {busy ? <Loader2 className="i composer__mic-spin" aria-hidden /> : recording ? <Square className="i" aria-hidden /> : <Mic className="i" aria-hidden />}
    </button>
  );
}

// Compact model picker: a small button (fixed width — never squeezes the prompt) that opens an
// upward popover of providers. Replaces the native <select>, whose width grew with the selected
// option's text ("name — model") and crowded the input out, unusably so on mobile.
function ModelMenu({
  provider, providers, onChange, disabled,
}: {
  provider: string;
  providers: ProviderOption[];
  onChange: (provider: string) => void;
  disabled?: boolean;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const current = providers.find((p) => p.name === provider);
  const label = provider ? (current?.name ?? provider) : "Default";
  const pick = (name: string): void => { onChange(name); setOpen(false); };

  return (
    <div className="composer__model-wrap">
      <button
        type="button"
        className="composer__model-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        title={current?.model ? `Model: ${current.name} — ${current.model}` : "Model for this conversation"}
        onClick={() => setOpen((v) => !v)}
      >
        <Cpu className="i i-sm" aria-hidden />
        <span className="composer__model-label">{label}</span>
        <ChevronDown className="i i-sm composer__model-caret" aria-hidden />
      </button>
      {open ? (
        <>
          <button type="button" className="composer__model-backdrop" aria-label="Close model menu" onClick={() => setOpen(false)} />
          <ul className="composer__model-menu" role="listbox" aria-label="Model">
            <ModelOpt label="Default" hint="host default" selected={provider === ""} onPick={() => pick("")} />
            {providers.map((p) => (
              <ModelOpt key={p.name} label={p.name} hint={p.model} selected={p.name === provider} onPick={() => pick(p.name)} />
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function ModelOpt({
  label, hint, selected, onPick,
}: { label: string; hint?: string; selected: boolean; onPick: () => void }): React.ReactElement {
  return (
    <li>
      <button type="button" role="option" aria-selected={selected} className="composer__model-opt" onClick={onPick}>
        <Check className={"i i-sm composer__model-tick" + (selected ? " is-on" : "")} aria-hidden />
        <span className="composer__model-opt-text">
          <span className="composer__model-opt-name">{label}</span>
          {hint ? <span className="composer__model-opt-hint">{hint}</span> : null}
        </span>
      </button>
    </li>
  );
}

// One pending attachment: base64 payload + its mime + filename. Built in the browser from a picked
// file; sent with the turn so the engine can fold it into the user message (images → vision blocks,
// text files → inlined into the prompt — see the engine's buildTurnContent).
export interface ComposerAttachment {
  name: string;
  mime: string;
  data: string;
}

// Total attachment budget (raw bytes, across all files on a turn). base64 inflates payloads ~33% and
// the whole turn body flows through the Vercel proxy, which caps request bodies at ~4.5MB — so keep
// the raw total ≈3MB (~4MB encoded) to stay safely under it. Plenty for screenshots/photos + text.
const MAX_ATTACH_BYTES = 3 * 1024 * 1024;

// Approximate the raw byte size of an already-encoded attachment (base64 length × 3/4).
function approxBytes(a: ComposerAttachment): number {
  return Math.floor((a.data.length * 3) / 4);
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.onload = () => {
      const s = String(r.result);
      const comma = s.indexOf(","); // strip the `data:<mime>;base64,` prefix
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    r.readAsDataURL(file);
  });
}

export interface ComposerProps {
  /**
   * Submit handler. The composer awaits the returned promise and
   * keeps itself disabled until it settles, mirroring the in-flight
   * lock pinned in `docs/014 §4.5`.
   */
  onSubmit: (text: string, attachments?: ComposerAttachment[]) => Promise<void>;
  /** Disabled while a turn is in flight (`docs/014 §4.5`). */
  disabled?: boolean;
  /** Selected matbot provider (one model each). When `onProviderChange` is set, a picker shows. */
  provider?: string;
  onProviderChange?: (provider: string) => void;
  /** Engine-reported providers for the picker (GET /api/providers). Empty → picker hidden. */
  providers?: ProviderOption[];
}

/**
 * The chat composer (UI_DESIGN_BRIEF §6): attach · auto-growing input ·
 * send. ``Enter`` submits, ``Shift+Enter`` inserts a newline. Empty /
 * whitespace-only submissions are dropped.
 */
export function Composer({
  onSubmit,
  disabled,
  provider,
  onProviderChange,
  providers,
}: ComposerProps): React.ReactElement {
  const [value, setValue] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [attachments, setAttachments] = React.useState<ComposerAttachment[]>([]);
  const [attachErr, setAttachErr] = React.useState<string | null>(null);
  const taRef = React.useRef<HTMLTextAreaElement | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  const isDisabled = disabled === true || submitting;

  // Grow the textarea with its content up to the CSS max-height.
  const autosize = React.useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, []);

  // Append transcribed text into the prompt (created early so mic hook can use it).
  const appendText = React.useCallback((text: string) => {
    if (!text) return;
    setValue((v) => (v.trim() ? `${v.trim()} ${text}` : text));
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        autosize();
        ta.focus();
      }
    });
  }, [autosize]);

  const mic = useMicRecorder(appendText);

  const onPickFiles = React.useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setAttachErr(null);
    let running = attachments.reduce((sum, a) => sum + approxBytes(a), 0);
    const next: ComposerAttachment[] = [];
    for (const f of Array.from(files)) {
      if (running + f.size > MAX_ATTACH_BYTES) {
        setAttachErr("Attachments are limited to ~3MB total");
        continue;
      }
      try {
        const data = await readAsBase64(f);
        next.push({ name: f.name, mime: f.type || "application/octet-stream", data });
        running += f.size;
      } catch {
        setAttachErr(`Couldn't read ${f.name}`);
      }
    }
    if (next.length) setAttachments((prev) => [...prev, ...next]);
  }, [attachments]);

  const removeAttachment = React.useCallback((idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const submit = React.useCallback(async () => {
    const text = value.trim();
    if (isDisabled) return;
    if (!text && attachments.length === 0) return; // need text or at least one file
    setSubmitting(true);
    try {
      await onSubmit(text, attachments.length ? attachments : undefined);
      setValue("");
      setAttachments([]);
      setAttachErr(null);
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) {
          ta.style.height = "auto";
          ta.focus();
        }
      });
    } finally {
      setSubmitting(false);
    }
  }, [value, isDisabled, onSubmit, attachments]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="composer-outer" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {attachments.length > 0 || attachErr ? (
        <div className="composer__chips" style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "2px 4px", alignItems: "center" }}>
          {attachments.map((a, i) => (
            <span key={`${a.name}-${i}`} className="composer__chip" title={a.name} style={{ display: "inline-flex", alignItems: "center", gap: 6, maxWidth: 220, border: "1px solid var(--border)", borderRadius: 8, padding: "2px 6px", fontSize: 12, background: "var(--muted, rgba(0,0,0,0.04))" }}>
              <Paperclip className="i i-sm" aria-hidden />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
              <button type="button" aria-label={`Remove ${a.name}`} onClick={() => removeAttachment(i)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, lineHeight: 1, color: "var(--faint)" }}>
                <X className="i i-sm" aria-hidden />
              </button>
            </span>
          ))}
          {attachErr ? <span style={{ fontSize: 12, color: "var(--alert)" }}>{attachErr}</span> : null}
        </div>
      ) : null}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        accept="image/*,text/*,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.xml,.log,.txt,.html,.css,.js,.ts,.py,.sql,.sh"
        onChange={(e) => { void onPickFiles(e.target.files); e.target.value = ""; }}
      />
      <ComposerMoreMenu
        onAttachClick={() => fileRef.current?.click()}
        onMicStart={mic.start}
        onMicStop={mic.stop}
        provider={provider ?? ""}
        providers={providers}
        onProviderChange={onProviderChange}
        disabled={isDisabled}
        micRecording={mic.recording}
        micBusy={mic.busy}
      />
      <textarea
        ref={taRef}
        className="composer__input"
        placeholder="Ask eidan anything…"
        rows={1}
        value={value}
        disabled={isDisabled}
        onChange={(e) => {
          setValue(e.target.value);
          autosize();
        }}
        onKeyDown={onKeyDown}
      />
      <button
        type="submit"
        className="btn btn--primary composer__send"
        aria-label="Send"
        disabled={isDisabled || (value.trim() === "" && attachments.length === 0)}
      >
        <Send className="i" aria-hidden />
      </button>
      </form>
    </div>
  );
}
