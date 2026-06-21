# @eidandev/charles-ventures

The **ventures registry** — the recursive org/venture/project scoping
spine every other Charles capability hangs off (charles#12). A
matbot plugin: it registers the venture-management tools the eidan brain
drives conversationally, over the `plugin_ventures.*` schema.

Ported from the Python `eidan_ventures` plugin onto the matbot runtime
(see the bundle's `docs/` for the design; this is the implementation).

## Tools

| Tool | Purpose |
|------|---------|
| `ventures_create`         | Create an org / venture / project node (nest via `parent_id`). |
| `ventures_list`           | List the operator's venture tree. |
| `venture_attach_resource` | Attach an external resource (social account / mailing list / analytics property) to a venture. |
| `venture_resources`       | List a venture's (or all) attached resources. |
| `venture_lookup_company`  | UK Companies House lookup → fold the official record into a venture's identity profile. |

## Layout

- `src/index.ts` — the `MatbotPluginSpec`; builds the `Db` from
  `EIDAN_DATABASE_URL` and registers the tools.
- `src/store.ts` — pure SQL over a `Q` query fn (unit-testable against a
  fake). Every statement is `user_id`-scoped.
- `src/identity.ts` — Companies House lookup (injectable `fetcher`).
- `src/tools.ts` — the matbot `Tool[]`; owner comes from the ambient
  `Principal`.
- `src/db.ts` — the principal-stamping transaction helper.

## Schema

`plugin_ventures.ventures` + `plugin_ventures.venture_resources`. Applied
via the bundle's `migrations/` runner (ordered `sql/*.sql`), not Alembic.

## Config

- `EIDAN_DATABASE_URL` (or `DATABASE_URL`) — Postgres connection (required).
- `EIDAN_COMPANIES_HOUSE_KEY` — free key from the CH developer hub
  (optional; only `venture_lookup_company` needs it).
