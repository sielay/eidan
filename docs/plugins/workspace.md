# Workspace · matbot engine plugin

Gives the eidan agent a small scratch-and-transfer area — the session **workspace** — to read, write, list, and delete files. It is not the host filesystem and not a code workspace (files here are not executable); it is the place for files the user uploads or downloads, generated artifacts (reports, charts, exports), and working notes. The agent uses it whenever it needs to hand a file to the user or stash an output between steps. When the matbot web frontend is running, every workspace file is also served as a static read-only download at `/workspace/<path>`, so the agent can give the user a direct link to anything it writes.

It is a plugin from the matbot engine (Apache-2.0, github.com/MatAtBread/matbot), available to enable in eidan. It runs in both node and browser runtimes and operates over the session's configured file store; in eidan that store is backed by Postgres via `@eidandev/storage-postgres`.

## Tools

| Tool | Purpose |
|---|---|
| `workspace_action` | Single multi-action file tool over the `workspace` namespace. `action: "read"` — read a file (`path`; `encoding` `utf8` default, or `base64` for binary), returns its contents. `action: "write"` — write a file (`path`, `content`; `encoding` as above), returns `{ path, bytes }` and infers a MIME type from the extension. `action: "list"` — list files (`path` is a filename-prefix filter, not a real dir; `recursive` includes subpaths), returns `[{ path, size }]`. `action: "delete"` — delete a file (`path`), returns `{ path }`. Paths are normalised and reject `..` traversal; reads/writes/deletes require `path`. |

## Example

```
workspace_action { "action": "write", "path": "report.md",
                   "content": "# Results\n…" }
→ result: { path: "report.md", bytes: 42 }

workspace_action { "action": "list", "recursive": true }
→ result: [ { path: "report.md", size: 42 }, { path: "charts/data.csv", size: 1200 } ]

workspace_action { "action": "read", "path": "charts/data.csv" }
→ result: "id,value\n1,10\n…"
```

## Notes

- Requires a configured file store for the session — if none is present, every action returns an error.
- Files are publicly viewable (served read-only at `/workspace/<path>` when the web frontend runs); prefer a dedicated link-minting tool over guessing a URL.
- Path safety: input is normalised and any `..` segment is rejected as escaping the workspace. `list`'s `path` is a literal filename prefix, so `"."` and `"/"` do not behave like directories.
- Use `base64` encoding for binary files (images, PDFs, zips); `utf8` (the default) for text. MIME type on write is derived from the file extension, defaulting to `application/octet-stream`.
