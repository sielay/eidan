// SPDX-License-Identifier: AGPL-3.0-or-later
// The user-facing model menu. Each option's `value` is a matbot **provider name** (configured in
// the host's matbot.yaml — one model per provider), so selecting an option selects a model. `""`
// means "use the server default" (EIDAN_AGUI_PROVIDER). The list is curated per deployment; values
// must match the provider names the engine actually has, or the turn silently falls back.
export interface ModelOption {
  value: string;
  label: string;
  note?: string;
}

export const MODEL_OPTIONS: ModelOption[] = [
  { value: "", label: "Default", note: "host default" },
  { value: "openrouter", label: "DeepSeek", note: "fast · cheap" },
  { value: "haiku", label: "Claude Haiku", note: "fast" },
  { value: "claude", label: "Claude Sonnet", note: "strong" },
];

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
