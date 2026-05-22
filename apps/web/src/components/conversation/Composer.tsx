"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";

export interface ComposerProps {
  /**
   * Submit handler. The composer awaits the returned promise and
   * keeps itself disabled until it settles, mirroring the in-flight
   * lock pinned in `docs/014 §4.5`.
   */
  onSubmit: (text: string) => Promise<void>;
  /** Disabled while a turn is in flight (`docs/014 §4.5`). */
  disabled?: boolean;
}

/**
 * Single textarea + send button. ``Enter`` submits, ``Shift+Enter``
 * inserts a newline. Empty / whitespace-only submissions are dropped.
 */
export function Composer({
  onSubmit,
  disabled,
}: ComposerProps): React.ReactElement {
  const [value, setValue] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const taRef = React.useRef<HTMLTextAreaElement | null>(null);

  const isDisabled = disabled === true || submitting;

  const submit = React.useCallback(async () => {
    const text = value.trim();
    if (!text || isDisabled) return;
    setSubmitting(true);
    try {
      await onSubmit(text);
      setValue("");
      // Restore focus on the next tick so the textarea is editable
      // again immediately after the in-flight lock releases.
      requestAnimationFrame(() => taRef.current?.focus());
    } finally {
      setSubmitting(false);
    }
  }, [value, isDisabled, onSubmit]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        ref={taRef}
        className="min-h-[44px] flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        placeholder="Reply…"
        rows={2}
        value={value}
        disabled={isDisabled}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <Button type="submit" disabled={isDisabled || value.trim() === ""}>
        Send
      </Button>
    </form>
  );
}
