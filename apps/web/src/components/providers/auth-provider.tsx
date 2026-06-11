// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import {
  fetchAuthConfig,
  type AuthConfig,
} from "@/lib/api/auth-config";
import {
  currentAccessToken,
  logout as nativeLogout,
  onAuthStateChange,
  refreshAccessToken,
} from "@/lib/auth";

interface AuthUser {
  id: string;
  email: string;
}

interface AuthContextValue {
  /** Backend-resolved auth config (publishable values only). */
  config: AuthConfig | null;
  /** Current logged-in operator, or null when signed out. */
  user: AuthUser | null;
  /** `true` while either the config or the initial refresh resolve. */
  loading: boolean;
  /** Legacy field — config failures now fall back to defaults, so this stays
   * null. Kept for compatibility with existing consumers. */
  configError: string | null;
  /** Sign out and clear the in-memory access token. */
  signOut: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextValue>({
  config: null,
  user: null,
  loading: true,
  configError: null,
  signOut: async () => {
    /* default no-op until the provider mounts */
  },
});

export function AuthProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [config, setConfig] = React.useState<AuthConfig | null>(null);
  const [user, setUser] = React.useState<AuthUser | null>(null);
  const [loading, setLoading] = React.useState(true);
  // Always null now — config failures fall back to defaults instead of blocking
  // the login form (the server middleware is the real gate).
  const [configError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const unsubscribe = onAuthStateChange((slot) => {
      if (slot === null) {
        setUser(null);
        return;
      }
      setUser({ id: slot.userId, email: slot.email });
    });

    (async () => {
      try {
        // Config is informational — the provider is always magic-link. A failed
        // or host-gated /api/auth/config must never replace the login form, so
        // fall back to the default. The server middleware is the real gate.
        let cfg: AuthConfig;
        try {
          cfg = await fetchAuthConfig();
        } catch {
          cfg = {
            provider: "magic-link",
            providers: ["magic-link"],
            tos_url: null,
            privacy_url: null,
          };
        }
        if (cancelled) return;
        setConfig(cfg);
        // Silent refresh: if the operator has a valid refresh cookie, this
        // lights up the in-memory access token + the onAuthStateChange listener
        // above flips `user`. Never throws — null just means logged out.
        await refreshAccessToken();
        if (cancelled) return;
        const slot = currentAccessToken();
        if (slot !== null) {
          setUser({ id: slot.userId, email: slot.email });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const signOut = React.useCallback(async () => {
    await nativeLogout();
  }, []);

  const value = React.useMemo<AuthContextValue>(
    () => ({ config, user, loading, configError, signOut }),
    [config, user, loading, configError, signOut],
  );

  return (
    <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  return React.useContext(AuthContext);
}
