---
id: configuration
title: Configuration
---

# Configuration

eidan is configured so an operator can run, deploy, and upgrade **without ever editing a tracked
file** — every operator-private choice lives in an env var, a secret, or a gitignored config path.

## The host config — `matbot.yaml`

The engine loads a `matbot.yaml` (gitignored; copy from `matbot.yaml.example`) that lists the
**plugins** to load and the **providers** (models) available. Core plugins are always included; add a
bundle by listing its plugins.

```yaml
plugins:
  - ./packages/memory
  - ./packages/agents
  - ./packages/journal
  # …enable a bundle by adding its plugins
providers:
  claude:
    module: ./external/matbot/packages/plugins/providers/anthropic
    endpoint: https://api.anthropic.com
    model: claude-sonnet-4-6
    credentials: { apiKey: ${ANTHROPIC_API_KEY} }
    parameters: { maxTokens: 16384 }
```

:::tip maxTokens
Set `parameters.maxTokens` on interactive chat providers. The adapter default is **4096**, which
truncates long answers mid-turn — raise it (e.g. 16384) so turns complete.
:::

## Key environment variables

| Variable | Purpose |
|---|---|
| `EIDAN_DATABASE_URL` | Postgres connection (a **non-superuser** role so RLS enforces). |
| `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` | Model provider keys. |
| `EIDAN_AUTH_MASTER_KEY` | Master key for the secrets vault + JWT signing. |
| `EIDAN_WHISPER_ENDPOINT` / `_KEY` / `_MODEL` | Voice transcription (OpenAI/Groq-compatible). |
| `EIDAN_NOTIFY_ROUTES` | Topic → Slack/Telegram routing. |
| `EIDAN_JOURNAL_NUDGE` | Set `0` to disable the journal's per-turn capture nudge. |

Config and secrets resolve from the **vault**, not `.env`, wherever possible — so a vaulted feature
reaches every node without per-node env. See the [vault concept](/concepts).

## Surfaces & ports

- AG-UI (web chat) — `:8090`
- MCP server — `:8091`
- A2A agent — `:8095`
- Reference web UI — `:3001` (Next.js)

## Migrations

The `eidan.*` schema is versioned SQL applied by the migrate runner:

```bash
EIDAN_DATABASE_URL=… pnpm --filter @eidandev/migrate migrate
```

Migrations are idempotent and additive. See **[Getting started](/getting-started)** for the full
run/deploy flow.
