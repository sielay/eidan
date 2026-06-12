// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";

/**
 * ScopeSwitcher — compact header context selector (design §3/§4): which
 * business/venture, which person, or which day-range. A dropdown, not a sidebar.
 */
export function ScopeSwitcher<T extends string>({
  options,
  value,
  onChange,
  ariaLabel = "Switch scope",
}: {
  options: ReadonlyArray<{ value: T; label: React.ReactNode }>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <div className="usermenu">
      <button
        type="button"
        className="scope"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {current?.label ?? value}
        <ChevronDown className="i-sm" aria-hidden />
      </button>
      {open ? (
        <>
          <div className="usermenu__backdrop" onClick={() => setOpen(false)} />
          <div className="usermenu__pop" role="menu">
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="menuitem"
                className="usermenu__item"
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
