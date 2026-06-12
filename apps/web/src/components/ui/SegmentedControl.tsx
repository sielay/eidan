// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

/** SegmentedControl / mode picker (design §3): e.g. food / drink / supplement. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: ReadonlyArray<{ value: T; label: React.ReactNode }>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
}): React.ReactElement {
  return (
    <div className="seg" role="tablist" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          className="seg__opt"
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
