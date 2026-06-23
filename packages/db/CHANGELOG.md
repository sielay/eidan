# @eidandev/db — changelog

## 0.1.0 (unreleased)

- Initial release. Connect to the operator's named databases and run read/write queries.
  - Drivers: **Postgres** (`db_query`, raw SQL) and **MongoDB** (`db_mongo`, command documents).
    Add an engine by dropping a module in `src/drivers/` and wiring the dispatch map — the
    registry/tool layer is driver-agnostic.
  - Tools: `db_list_connections`, `db_inspect`, `db_query`, `db_mongo`.
  - Connections are managed in **Integrations → Databases** (`plugin_db.connections`); only the
    password is sealed in the per-user vault under `EIDAN_DB_PASS_<slug>`. Secret values never flow
    through the LLM — the admin route seals via the engine secrets-api; tools resolve at call time.
