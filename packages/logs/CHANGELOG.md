# @eidandev/logs — changelog

## 0.1.0 (unreleased)

- Initial release. Read deployment/app logs from the operator's named log sources.
  - Providers: **Vercel** (deployment events), **Heroku** (Platform API log-sessions), **Better
    Stack** (ClickHouse query API), **Fly** (operator-set drain/aggregator `base_url` — Fly has no
    first-party HTTP log-pull). Add a platform by dropping a module in `src/providers/` and wiring
    the dispatch map — the registry/tool layer is provider-agnostic.
  - Tools: `logs_list_sources`, `logs_read` (limit / since / query).
  - Sources are managed in **Integrations → Logs** (`plugin_logs.sources`); only the API token is
    sealed in the per-user vault under `EIDAN_LOG_TOKEN_<slug>`. Secret values never flow through the
    LLM — the admin route seals via the engine secrets-api; tools resolve at call time.
