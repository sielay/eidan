// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import type { AskField } from "@/lib/api/turn";

/**
 * The interactive control for a mid-turn ``ask_user`` question. The agent
 * paused the turn to ask the user something (matbot's ``ask_user`` tool →
 * ``ctx.prompt``), and the turn is blocked server-side until this resolves
 * it. We render the right input for the field type; submitting calls
 * ``onAnswer`` (cancelling ``onCancel``), which POSTs back via
 * ``answerPrompt`` so the turn streams on over the same SSE connection.
 *
 * Mirrors matbot's own web frontend prompt controls: ``confirm`` → Yes/No,
 * ``select`` → option buttons (+ optional free-text "Other…"), ``text`` /
 * ``password`` → a (masked) input. ``cancelable === false`` hides the
 * "give up" affordance per the field contract.
 */
export function AskUserForm({
  field,
  disabled,
  onAnswer,
  onCancel,
}: {
  field: AskField;
  disabled?: boolean;
  onAnswer: (answer: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [text, setText] = React.useState(field.default ?? "");
  // select + allowOther: toggled into a free-text answer instead of an option pick.
  const [otherMode, setOtherMode] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const cancelable = field.cancelable !== false;
  const showTextInput = field.type === "text" || field.type === "password" || otherMode;
  const canSubmit = !disabled && (!field.required || text.trim().length > 0);

  React.useEffect(() => {
    if (showTextInput) inputRef.current?.focus();
  }, [showTextInput]);

  const submitText = (): void => {
    if (!canSubmit) return;
    onAnswer(text.trim() ? text : (field.default ?? ""));
  };

  const optionBtn = (label: string, onClick: () => void, primary?: boolean): React.ReactElement => (
    <button
      key={label}
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        padding: "6px 12px",
        borderRadius: 8,
        border: "1px solid var(--border)",
        cursor: disabled ? "default" : "pointer",
        background: primary ? "var(--accent, #6366f1)" : "var(--surface, #fff)",
        color: primary ? "#fff" : "var(--text)",
        fontSize: "var(--fs-14)",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      role="group"
      aria-label="Question from the assistant"
      style={{
        margin: "var(--s4) 0",
        padding: "var(--s4)",
        borderRadius: "var(--r-md, 10px)",
        border: "1px solid var(--accent, #6366f1)",
        background: "var(--accent-soft, rgba(99, 102, 241, 0.08))",
        display: "flex",
        flexDirection: "column",
        gap: "var(--s3, 10px)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span aria-hidden style={{ fontSize: "var(--fs-13)" }}>💬</span>
        <span style={{ fontWeight: 600, color: "var(--text)" }}>{field.label || "The assistant needs your input"}</span>
      </div>

      {field.type === "confirm" ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {optionBtn("Yes", () => onAnswer("Yes"), true)}
          {optionBtn("No", () => onAnswer("No"))}
        </div>
      ) : null}

      {field.type === "select" && !otherMode ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(field.options ?? []).map((opt) => optionBtn(opt, () => onAnswer(opt), opt === field.default))}
          {field.allowOther ? optionBtn("Other…", () => setOtherMode(true)) : null}
        </div>
      ) : null}

      {showTextInput ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            ref={inputRef}
            type={field.type === "password" ? "password" : "text"}
            value={text}
            disabled={disabled}
            placeholder={field.type === "password" ? "Enter value (hidden)" : "Type your answer…"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); submitText(); }
            }}
            style={{
              flex: 1,
              minWidth: 180,
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--bg, #fff)",
              color: "var(--text)",
              fontSize: "var(--fs-14)",
            }}
          />
          {optionBtn("Send", submitText, true)}
          {otherMode ? optionBtn("Back", () => { setOtherMode(false); setText(field.default ?? ""); }) : null}
        </div>
      ) : null}

      {cancelable ? (
        <button
          type="button"
          disabled={disabled}
          onClick={onCancel}
          style={{
            alignSelf: "flex-start",
            border: "none",
            background: "transparent",
            color: "var(--muted)",
            cursor: disabled ? "default" : "pointer",
            fontSize: "var(--fs-13)",
            padding: 0,
            textDecoration: "underline",
            textUnderlineOffset: 2,
          }}
        >
          Cancel
        </button>
      ) : null}
    </div>
  );
}
