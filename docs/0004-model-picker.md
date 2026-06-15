<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0004 — Model picker (per-conversation provider selection)

Status: **Shipped** — a per-conversation provider dropdown in the web chat composer.

## Goal

eidan is model-agnostic by design: providers are declared in `matbot.yaml` (Anthropic by
default, OpenRouter and other OpenAI-compatible endpoints opt-in). The model picker surfaces
that to the user — pick which configured provider answers *this* conversation, so cheap/fast
models handle throwaway chat and a strong model handles the hard ones, without touching
config or redeploying.

## How it works

The selection is **per conversation** and **client-side**. There is no DB column for it:
the chat sends the chosen provider on each turn and the engine validates it.

1. **UI** — `apps/web/src/components/conversation/Composer.tsx` renders a `<select>` of
   `MODEL_OPTIONS` (only when the parent passes `onProviderChange`).
   `ConversationView.tsx` loads the saved choice on mount and saves it on change.
2. **Persistence** — `localStorage`: `eidan.provider.<conversationId>` per conversation,
   `eidan.provider.default` as the fallback (`apps/web/src/lib/models.ts`). Empty string =
   "host default".
3. **On the wire** — the choice rides the turn request as the optional `provider` field
   (`TurnInput` in `apps/web/src/lib/schemas.ts`); an empty choice is omitted entirely.
4. **Engine** — `packages/frontend-agui/src/server.ts` validates it against the live
   registry: `const turnProvider = body.provider && services.providers.get(body.provider) ?
   body.provider : provider;` — an unknown provider silently falls back to the server
   default. The chosen provider is passed into `run.open({ …, provider: turnProvider })`.

## The provider list (two halves that must agree)

- **Source of truth (engine):** the `providers:` map in `matbot.yaml`. Each entry names a
  provider (`claude`, `openrouter`, `haiku`, …), its matbot adapter module, model string,
  and credentials (`${ANTHROPIC_API_KEY}`, `${OPENROUTER_API_KEY}`, …).
- **Curated list (UI):** `MODEL_OPTIONS` in `apps/web/src/lib/models.ts` — the human-labelled
  dropdown (e.g. `"Default" / "DeepSeek" / "Claude Haiku" / "Claude Sonnet"`).

The two are **not auto-synced**: a dropdown `value` must match a provider key the engine
actually has. When you add or rename a provider in `matbot.yaml`, update `MODEL_OPTIONS` to
match — an unmatched value just falls back to the default at turn time (no error).

## Defaults & config

- **Server default provider** — `EIDAN_AGUI_PROVIDER`, falling back to `EIDAN_JOB_PROVIDER`,
  falling back to `'claude'` (`packages/frontend-agui/src/index.ts`). Used whenever a turn
  carries no valid `provider`.
- **Credentials** — per-provider API keys referenced from `matbot.yaml` and resolved from
  env/vault (`${ANTHROPIC_API_KEY}`, `${OPENROUTER_API_KEY}`, …).

## Known limitations

- **No cross-device persistence.** The choice lives in browser `localStorage`, so it doesn't
  follow the user to another device/browser; each starts at the host default.
- **`eidan.messages.model` not populated.** The schema has both `provider` and `model`
  columns; only `provider` is written by the storage layer today.
- **Cost-ledger attribution bug** (`frontend-agui/src/server.ts`): the per-call ledger
  currently records the *server-default* `provider` rather than the user-selected
  `turnProvider`, so `eidan.llm_calls` mis-attributes the provider when a user overrides it.
  Tracked as follow-up; does not affect which model actually answers.

## Files of record

- `apps/web/src/lib/models.ts` — `MODEL_OPTIONS`, localStorage load/save.
- `apps/web/src/components/conversation/{Composer,ConversationView}.tsx` — the picker + glue.
- `apps/web/src/lib/schemas.ts` — `TurnInput.provider`.
- `packages/frontend-agui/src/server.ts` — provider validation + `run.open`.
- `packages/frontend-agui/src/index.ts` — server-default provider resolution.
- `matbot.yaml.example` — the `providers:` block (source of truth).
