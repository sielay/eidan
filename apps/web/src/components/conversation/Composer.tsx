// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { Check, ChevronDown, Cpu, GitFork, Loader2, Mic, MoreVertical, Paperclip, Send, Square, X } from "lucide-react";

import { isTranscribeAvailable, transcribeAudio } from "@/lib/api/transcribe";
import type { ProviderOption } from "@/lib/models";
import type { OpenRouterModel } from "@/lib/api/admin";
import { useTextareaMentions } from "./useTextareaMentions";

// Filter the OpenRouter catalogue by a query against id/name; capped so a 300+ list stays a menu.
function filterCatalog(catalog: OpenRouterModel[] | undefined, q: string, limit = 40): OpenRouterModel[] {
  const s = q.trim().toLowerCase();
  if (!s || !catalog) return [];
  const out: OpenRouterModel[] = [];
  for (const m of catalog) {
    if (m.id.toLowerCase().includes(s) || m.name.toLowerCase().includes(s)) { out.push(m); if (out.length >= limit) break; }
  }
  return out;
}

// Parse a parameter size out of the model id/name: 8x7b (MoE), 480b-a35b (total/active), or plain 70b.
function paramSize(m: OpenRouterModel): string | null {
  const hay = `${m.name} ${m.id}`.toLowerCase();
  const moe = hay.match(/(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)b/);
  if (moe) return `${moe[1]}×${moe[2]}B`;
  const ta = hay.match(/(\d+(?:\.\d+)?)b[-\s]?a(\d+(?:\.\d+)?)b/);
  if (ta) return `${ta[1]}B-A${ta[2]}B`;
  const plain = hay.match(/(?:^|[^a-z\d.])(\d{1,4}(?:\.\d+)?)b(?:[^a-z]|$)/);
  if (plain) return `${plain[1]}B`;
  return null;
}
function fmtCtx(n: number | null | undefined): string | null {
  if (!n) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return `${n}`;
}
function perM(x: number): string { const v = x * 1_000_000; return v === 0 ? "$0" : v < 0.1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`; }
function fmtPrice(m: OpenRouterModel): string | null {
  const p = m.prompt == null ? NaN : Number(m.prompt);
  const c = m.completion == null ? NaN : Number(m.completion);
  if (Number.isNaN(p) && Number.isNaN(c)) return null;
  if (p === 0 && c === 0) return "free";
  return `${Number.isNaN(p) ? "?" : perM(p)}/${Number.isNaN(c) ? "?" : perM(c)} per M`;
}
// One compact meta line: "70B · 128K ctx · $0.50/$1.50 per M".
function modelMeta(m: OpenRouterModel): string {
  const ctx = fmtCtx(m.context);
  return [paramSize(m), ctx ? `${ctx} ctx` : null, fmtPrice(m)].filter(Boolean).join(" · ");
}

// Mobile menu: collapse attach, record, model picker into a single menu button with popover.
// Opens above the send button to preserve horizontal width for the input field.
function ComposerMoreMenu({
  onAttachClick,
  onMicStart,
  onMicStop,
  provider,
  providers,
  catalog,
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
  catalog?: OpenRouterModel[];
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
            {onProviderChange && ((providers && providers.length > 0) || (catalog && catalog.length > 0)) ? (
              <ComposerMoreModelMenu provider={provider} providers={providers ?? []} catalog={catalog} onChange={onProviderChange} onClose={() => setOpen(false)} />
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
  catalog,
  onChange,
  onClose,
}: {
  provider: string;
  providers: ProviderOption[];
  catalog?: OpenRouterModel[];
  onChange: (p: string) => void;
  onClose: () => void;
}): React.ReactElement {
  const [modelOpen, setModelOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const current = providers.find((p) => p.name === provider);
  const label = provider ? (current?.name ?? provider) : "Default";
  const hits = filterCatalog(catalog, search);
  const pickModel = (value: string): void => { onChange(value); setModelOpen(false); setSearch(""); onClose(); };

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
              onClick={() => pickModel(p.name)}
            >
              <Check className={"i i-sm composer__more-model-tick" + (p.name === provider ? " is-on" : "")} aria-hidden />
              <span>{p.name}</span>
              <span className="composer__more-model-hint">{p.model}</span>
            </button>
          ))}
          {catalog && catalog.length > 0 ? (
            <>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={`Search ${catalog.length} models…`}
                aria-label="Search all models"
                className="composer__more-model-search"
                style={{ width: "calc(100% - 16px)", margin: "4px 8px", padding: "4px 8px", fontSize: "var(--fs-13, 13px)", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)" }}
              />
              {hits.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="menuitemradio"
                  className="composer__more-model-opt"
                  aria-checked={m.id === provider}
                  onClick={() => pickModel(m.id)}
                  title={m.id}
                  style={{ alignItems: "flex-start" }}
                >
                  <Check className={"i i-sm composer__more-model-tick" + (m.id === provider ? " is-on" : "")} aria-hidden style={{ marginTop: 2 }} />
                  <span style={{ display: "flex", flexDirection: "column", minWidth: 0, gap: 1 }}>
                    <span style={{ whiteSpace: "normal", lineHeight: 1.25 }}>{m.name}</span>
                    {modelMeta(m) ? <span className="composer__more-model-hint" style={{ fontVariantNumeric: "tabular-nums" }}>{modelMeta(m)}</span> : null}
                  </span>
                </button>
              ))}
              {search.trim() && hits.length === 0 ? <div className="composer__more-model-hint" style={{ padding: "4px 12px" }}>No models match “{search.trim()}”.</div> : null}
            </>
          ) : null}
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

// Fork-and-merge ("⑂ Compare"): pick ≥2 models to race this prompt against in parallel. The current
// model (the picker above) then judges them and merges the best result into one answer. A small
// branch button that opens an upward popover of provider checkboxes; the badge shows how many are on.
function CompareMenu({
  providers, catalog, selected, judge, onToggle, disabled,
}: {
  providers: ProviderOption[];
  catalog?: OpenRouterModel[];
  selected: string[];
  judge: string;
  onToggle: (name: string) => void;
  disabled?: boolean;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  const n = selected.length;
  const judgeLabel = judge ? (providers.find((p) => p.name === judge)?.name ?? judge) : "Default";
  const providerNames = new Set(providers.map((p) => p.name));
  const extraSelected = selected.filter((s) => !providerNames.has(s)); // chosen catalogue slugs
  const hits = filterCatalog(catalog, search).filter((m) => !selected.includes(m.id));

  return (
    <div className="composer__model-wrap">
      <button
        type="button"
        className={"composer__model-btn" + (n >= 2 ? " is-on" : "")}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title={n >= 2 ? `Compare ${n} models — ${judgeLabel} judges & merges` : "Compare this prompt across models"}
        onClick={() => setOpen((v) => !v)}
        style={n >= 2 ? { color: "var(--accent, #6366f1)", borderColor: "var(--accent, #6366f1)" } : undefined}
      >
        <GitFork className="i i-sm" aria-hidden />
        {n >= 2 ? <span className="composer__model-label">{n}</span> : null}
      </button>
      {open ? (
        <>
          <button type="button" className="composer__model-backdrop" aria-label="Close compare menu" onClick={() => setOpen(false)} />
          <ul className="composer__model-menu" role="menu" aria-label="Compare across models">
            <li style={{ padding: "6px 10px", fontSize: 12, color: "var(--faint)", lineHeight: 1.4, borderBottom: "1px solid var(--border)" }}>
              Pick 2+ models to race in parallel. <strong>{judgeLabel}</strong> judges &amp; merges the best answer.
            </li>
            {providers.map((p) => {
              const on = selected.includes(p.name);
              return (
                <li key={p.name}>
                  <button type="button" role="menuitemcheckbox" aria-checked={on} className="composer__model-opt" onClick={() => onToggle(p.name)}>
                    <Check className={"i i-sm composer__model-tick" + (on ? " is-on" : "")} aria-hidden />
                    <span className="composer__model-opt-text">
                      <span className="composer__model-opt-name">{p.name}</span>
                      <span className="composer__model-opt-hint">{p.model}</span>
                    </span>
                  </button>
                </li>
              );
            })}
            {/* Chosen catalogue models (slugs not in the configured providers) — shown so they're removable. */}
            {extraSelected.map((slug) => (
              <li key={slug}>
                <button type="button" role="menuitemcheckbox" aria-checked className="composer__model-opt" onClick={() => onToggle(slug)} title={slug}>
                  <Check className="i i-sm composer__model-tick is-on" aria-hidden />
                  <span className="composer__model-opt-text">
                    <span className="composer__model-opt-name" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{slug}</span>
                    <span className="composer__model-opt-hint">catalogue</span>
                  </span>
                </button>
              </li>
            ))}
            {catalog && catalog.length > 0 ? (
              <li>
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={`Search ${catalog.length} models…`}
                  aria-label="Search all models to compare"
                  style={{ width: "calc(100% - 16px)", margin: "4px 8px", padding: "4px 8px", fontSize: 13, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)" }}
                />
              </li>
            ) : null}
            {hits.map((m) => (
              <li key={m.id}>
                <button type="button" role="menuitemcheckbox" aria-checked={false} className="composer__model-opt" onClick={() => onToggle(m.id)} title={m.id} style={{ alignItems: "flex-start" }}>
                  <Check className="i i-sm composer__model-tick" aria-hidden style={{ marginTop: 2 }} />
                  <span className="composer__model-opt-text">
                    <span className="composer__model-opt-name" style={{ whiteSpace: "normal", lineHeight: 1.25 }}>{m.name}</span>
                    <span className="composer__model-opt-hint" style={{ fontVariantNumeric: "tabular-nums" }}>{modelMeta(m) || (m.id.split("/")[0] ?? "")}</span>
                  </span>
                </button>
              </li>
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
  onSubmit: (text: string, attachments?: ComposerAttachment[], compare?: string[]) => Promise<void>;
  /** Disabled while a turn is in flight (`docs/014 §4.5`). */
  disabled?: boolean;
  /** Selected matbot provider (one model each). When `onProviderChange` is set, a picker shows. */
  provider?: string;
  onProviderChange?: (provider: string) => void;
  /** Engine-reported providers for the picker (GET /api/providers). Empty → picker hidden. */
  providers?: ProviderOption[];
  /** Full OpenRouter catalogue — lets the picker + ⑂ Compare choose ANY model, not just providers. */
  catalog?: OpenRouterModel[];
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
  catalog,
}: ComposerProps): React.ReactElement {
  const [value, setValue] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [attachments, setAttachments] = React.useState<ComposerAttachment[]>([]);
  const [attachErr, setAttachErr] = React.useState<string | null>(null);
  // Fork-and-merge selection: provider names to race the next prompt against (sticky across sends so
  // you can compare several prompts). Pruned to names the engine still offers when `providers` change.
  const [compareModels, setCompareModels] = React.useState<string[]>([]);
  React.useEffect(() => {
    // Drop selections that are no longer valid (a renamed/removed provider), but KEEP catalogue slugs.
    if ((!providers || !providers.length) && (!catalog || !catalog.length)) return;
    const valid = new Set<string>([...(providers ?? []).map((p) => p.name), ...(catalog ?? []).map((m) => m.id)]);
    setCompareModels((prev) => prev.filter((n) => valid.has(n)));
  }, [providers, catalog]);
  const toggleCompare = React.useCallback((name: string) => {
    setCompareModels((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]));
  }, []);
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

  const [micAvailable, setMicAvailable] = React.useState(false);
  const [recording, setRecording] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const recRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const streamRef = React.useRef<MediaStream | null>(null);

  const canRecord = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";

  React.useEffect(() => {
    if (!canRecord) return;
    void isTranscribeAvailable().then(setMicAvailable).catch(() => setMicAvailable(false));
  }, [canRecord]);

  const stopTracks = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  React.useEffect(() => () => { recRef.current?.stop(); stopTracks(); }, [stopTracks]);

  const micStart = React.useCallback(async () => {
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
        void transcribeAudio(blob).then(appendText).catch(() => { /* no text on failure */ }).finally(() => setBusy(false));
      };
      rec.start();
      recRef.current = rec;
      setRecording(true);
    } catch {
      stopTracks();
      setRecording(false);
    }
  }, [appendText, stopTracks]);

  const micStop = React.useCallback(() => {
    recRef.current?.stop();
    recRef.current = null;
    setRecording(false);
  }, []);

  const mic = { available: micAvailable, recording, busy, start: micStart, stop: micStop };

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
      await onSubmit(text, attachments.length ? attachments : undefined, compareModels.length >= 2 ? compareModels : undefined);
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
  }, [value, isDisabled, onSubmit, attachments, compareModels]);

  // @-mention autocomplete (files/folders/agents/ventures/assets) — inserts resolvable tokens the
  // engine expands at turn time.
  const mentions = useTextareaMentions(taRef, value, setValue);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (mentions.handleKeyDown(e)) return; // @-mention popover claims arrows / enter / esc while open
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
        catalog={catalog}
        onProviderChange={onProviderChange}
        disabled={isDisabled}
        micRecording={mic.recording}
        micBusy={mic.busy}
      />
      {onProviderChange && ((providers && providers.length >= 2) || (catalog && catalog.length > 0)) ? (
        <CompareMenu
          providers={providers ?? []}
          catalog={catalog}
          selected={compareModels}
          judge={provider ?? ""}
          onToggle={toggleCompare}
          disabled={isDisabled}
        />
      ) : null}
      <div style={{ position: "relative", flex: 1, display: "flex" }}>
        <textarea
          ref={taRef}
          className="composer__input"
          placeholder={compareModels.length >= 2 ? `⑂ Compare ${compareModels.length} models — ask anything…` : "Ask eidan anything… (@ to mention a file, agent, …)"}
          rows={1}
          value={value}
          disabled={isDisabled}
          onChange={(e) => {
            setValue(e.target.value);
            autosize();
            mentions.recompute();
          }}
          onKeyUp={() => mentions.recompute()}
          onClick={() => mentions.recompute()}
          onKeyDown={onKeyDown}
          style={{ flex: 1 }}
        />
        {mentions.popover}
      </div>
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
