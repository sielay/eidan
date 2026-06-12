// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { type Zone } from "./cx";

const ZONE_VAR: Record<Zone, string> = {
  good: "var(--good)",
  info: "var(--info)",
  warn: "var(--warn)",
  alert: "var(--alert)",
  neutral: "var(--faint)",
};

interface ToastItem {
  id: number;
  message: React.ReactNode;
  zone: Zone;
}

interface ToastApi {
  toast: (message: React.ReactNode, opts?: { zone?: Zone; durationMs?: number }) => void;
}

const ToastContext = React.createContext<ToastApi>({ toast: () => {} });

/** Imperative toaster (design §3): `const { toast } = useToast(); toast("Saved")`. */
export function useToast(): ToastApi {
  return React.useContext(ToastContext);
}

/**
 * Mount once near the app root. Logging/quick-add flows close to a toast
 * (design §4). Stacks bottom-centre, auto-dismisses.
 */
export function ToastProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const idRef = React.useRef(0);

  const toast = React.useCallback<ToastApi["toast"]>((message, opts) => {
    const id = ++idRef.current;
    setItems((xs) => [...xs, { id, message, zone: opts?.zone ?? "good" }]);
    const ms = opts?.durationMs ?? 2600;
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), ms);
  }, []);

  const api = React.useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        style={{
          position: "fixed",
          left: "50%",
          bottom: "calc(72px + env(safe-area-inset-bottom, 0px))",
          transform: "translateX(-50%)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--s2)",
          zIndex: 200,
          pointerEvents: "none",
        }}
      >
        {items.map((t) => (
          <div key={t.id} className="toast" style={{ pointerEvents: "auto" }}>
            <span className="toast__dot" style={{ background: ZONE_VAR[t.zone] }} />
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
