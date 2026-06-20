# Tool Store · matbot engine plugin

Tool Store lets the agent define **named persistent stores** — typed key-value
collections of documents keyed by id — and exposes a generated CRUD tool over
each. Defining or exposing a store mints a `<namespace>_action` tool that the
model can use to get, set (upsert), compare-and-swap, delete, and query that
store's documents. The plugin keeps its own record of every store it manages
(the document shape and description), so those generated tools are
re-registered automatically on restart.

This is a plugin from the matbot engine (Apache-2.0,
[github.com/MatAtBread/matbot](https://github.com/MatAtBread/matbot)), available
to enable in eidan. The eidan agent reaches for it whenever it needs a small,
self-described, structured datastore it can read and write on the fly — for
example a list, a lookup table, or a set of records — without a bespoke
backend. Other plugins also build on it: eidan's cognition plugin seeds its
`remembered_facts` store through this mechanism.

## Tools

| Tool | Purpose |
| --- | --- |
| `store_action` | Manage store definitions. `create` (new store + tool; fails if it already exists), `expose` (tool over an existing store; fails if absent), `get` (read one store's definition), `remove` (drop the definition and its tool — store data is left intact), `list` (all managed stores). `create`/`expose` require `namespace`, a plain-English `description`, and a `shape` (a flattened TypeScript type/interface shown to the model). |
| `<namespace>_action` | The generated per-store tool. Verbs map onto the matbot `Store<T>` interface: `get { id }`, `set { id?, data }` (upsert; id omitted ⇒ created), `cas { id, expected, data }` (compare-and-swap on version), `delete { id, expected? }`, `query { query? }` (omit ⇒ match all). Returns `{ items, cursor?, total? }` for queries. |

## Example

```
store_action({ action: "create", namespace: "books",
  description: "Books the user has read",
  shape: "interface Book { title: string; author: string; rating: number }" })
books_action({ action: "set", data: { title: "Dune", author: "Herbert", rating: 5 } })
books_action({ action: "query", query: { where: { op: "gte", field: "rating", value: 4 } } })
```

## Notes

- Cross-runtime: runs in both Node and the browser (no network capability required).
- `version` is managed automatically (a fresh one is minted on every `set`/`cas`); never set it yourself. Pass the value you last read as `expected` to `cas`/`delete` for safe concurrent updates.
- The `query` grammar supports `where` filters (`eq`/`neq`/`lt`/`gt`/`in`/`exists`/`stringContains`/`arrayContains`/`and`/`or`/`not`), `sort`, `limit`, and opaque `cursor` paging. Comparisons are type-strict (`5 ≠ "5"`).
- The `shape` is advisory for now — surfaced to the model but not yet enforced at write time. It is kept as canonical TypeScript so it can later drive validation, SQL columns, or a NoSQL schema.
- `store_tools` is a reserved namespace (the plugin's own meta store).
