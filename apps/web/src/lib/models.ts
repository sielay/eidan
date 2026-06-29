// SPDX-License-Identifier: AGPL-3.0-or-later
// The user-facing model menu is built at runtime from the engine's ACTUALLY-configured providers
// (GET /api/providers), not a hardcoded list. Each matbot provider is one fully-resolved model, so
// the menu value is the provider **name** and the label shows its model. This is deliberate: a
// hand-maintained client list drifts out of sync with matbot.yaml and the engine then silently
// falls back to the default (EIDAN_AGUI_PROVIDER) — which is how the menu's "DeepSeek" option (a
// stale alias for the `openrouter` provider, configured to sonnet) ended up running sonnet.
import { authFetch } from "@/lib/auth";

// One configured provider as reported by the engine. `name` is the matbot provider name (the value
// sent on the turn); `model` is the resolved model it runs (shown to the user so the label is true).
export interface ProviderOption {
  name: string;
  model: string;
}

// Fetch the engine's live provider registry. `""` (server default) is always offered separately by
// the picker, so this is just the explicit choices.
export async function listProviders(): Promise<ProviderOption[]> {
  const res = await authFetch("/api/providers", {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET /api/providers returned ${res.status}`);
  const body = (await res.json()) as { providers?: ProviderOption[] };
  // Internal / alias providers that shouldn't clutter the user's model menu: classifier + inner-voice
  // helpers, and `openrouter-haiku` (a back-compat alias now repointed to native Anthropic, so it's a
  // confusing duplicate of `haiku`). Hidden from selection; existing saved picks still resolve.
  return (body.providers ?? []).filter((p) => !HIDDEN_PROVIDERS.has(p.name));
}

const HIDDEN_PROVIDERS = new Set([
  "openrouter-haiku",
  "openrouter-free",
  "inner-voice",
  "skills-classifier",
]);

const KEY_DEFAULT = "eidan.provider.default";
const keyFor = (conversationId: string): string => `eidan.provider.${conversationId}`;

// Resolve the provider for a conversation: its own remembered choice, else the last-used default,
// else "" (server default). Client-only.
export function loadProvider(conversationId: string): string {
  if (typeof window === "undefined") return "";
  return (
    window.localStorage.getItem(keyFor(conversationId)) ??
    window.localStorage.getItem(KEY_DEFAULT) ??
    ""
  );
}

// Persist a choice for this conversation, and make it the new default for fresh chats too.
export function saveProvider(conversationId: string, provider: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(keyFor(conversationId), provider);
  window.localStorage.setItem(KEY_DEFAULT, provider);
}
