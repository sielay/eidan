// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { cx } from "./cx";

/**
 * Sheet — bottom sheet for detail/logging (design §4: "Detail = bottom sheet,
 * never a cramped modal"). Closes on backdrop click or Escape.
 */
export function Sheet({
  open,
  onClose,
  label,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label?: string;
  className?: string;
  children: React.ReactNode;
}): React.ReactElement | null {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={label} onClick={onClose}>
      <div className={cx("sheet", className)} onClick={(e) => e.stopPropagation()}>
        <div className="sheet__grip" />
        {children}
      </div>
    </div>
  );
}

/**
 * QuickAddSheet — fast-logging sheet (design §3/§4): presets first, then fields,
 * big submit, closes to a toast. `presets` are one-tap; `children` holds fields.
 */
export function QuickAddSheet({
  open,
  onClose,
  title,
  presets,
  onSubmit,
  submitLabel = "Add",
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  presets?: ReadonlyArray<{ label: React.ReactNode; onSelect: () => void }>;
  onSubmit?: () => void;
  submitLabel?: React.ReactNode;
  children?: React.ReactNode;
}): React.ReactElement | null {
  return (
    <Sheet open={open} onClose={onClose} label={typeof title === "string" ? title : "Quick add"}>
      <div className="sheet-head">
        <h3>{title}</h3>
        <button type="button" className="btn--quiet" onClick={onClose}>
          Close
        </button>
      </div>
      {presets && presets.length ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s2)", marginBottom: "var(--s4)" }}>
          {presets.map((p, i) => (
            <button key={i} type="button" className="chip" onClick={p.onSelect}>
              {p.label}
            </button>
          ))}
        </div>
      ) : null}
      {children}
      {onSubmit ? (
        <button
          type="button"
          className="btn btn--primary btn--block btn--lg"
          style={{ marginTop: "var(--s4)" }}
          onClick={onSubmit}
        >
          {submitLabel}
        </button>
      ) : null}
    </Sheet>
  );
}
