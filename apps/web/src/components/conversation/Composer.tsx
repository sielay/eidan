// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { Paperclip, Send } from "lucide-react";

import { MODEL_OPTIONS } from "@/lib/models";

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
      {onProviderChange ? (
        <select
          className="composer__model"
          aria-label="Model"
          title="Model for this conversation"
          value={provider ?? ""}
          disabled={isDisabled}
          onChange={(e) => onProviderChange(e.target.value)}
        >
          {MODEL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
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
