// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { Check, ChevronDown, Cpu, Paperclip, Send } from "lucide-react";

import type { ProviderOption } from "@/lib/models";

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

export interface ComposerProps {
  /**
   * Submit handler. The composer awaits the returned promise and
   * keeps itself disabled until it settles, mirroring the in-flight
   * lock pinned in `docs/014 §4.5`.
   */
  onSubmit: (text: string) => Promise<void>;
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
  const taRef = React.useRef<HTMLTextAreaElement | null>(null);

  const isDisabled = disabled === true || submitting;

  // Grow the textarea with its content up to the CSS max-height.
  const autosize = React.useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, []);

  const submit = React.useCallback(async () => {
    const text = value.trim();
    if (!text || isDisabled) return;
    setSubmitting(true);
    try {
      await onSubmit(text);
      setValue("");
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
  }, [value, isDisabled, onSubmit]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <button
        type="button"
        className="iconbtn composer__attach"
        aria-label="Attach (coming soon)"
        title="Attachments coming soon"
        disabled
      >
        <Paperclip className="i" aria-hidden />
      </button>
      {onProviderChange && providers && providers.length > 0 ? (
        <ModelMenu provider={provider ?? ""} providers={providers} onChange={onProviderChange} disabled={isDisabled} />
      ) : null}
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
        disabled={isDisabled || value.trim() === ""}
      >
        <Send className="i" aria-hidden />
      </button>
    </form>
  );
}
