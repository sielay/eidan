# Background · matbot engine plugin

The `background` plugin runs a prompt in a detached background process so the eidan agent can kick off work without blocking the current conversation. With no interval the prompt runs once and the tool returns immediately; with an interval it becomes a recurring schedule that persists across restarts. The background job has access to the same tools and providers as the foreground agent, and it runs under the identity of whoever scheduled it (the creator's principal is captured and replayed on each fire).

This is a plugin from the matbot engine (Apache-2.0, github.com/MatAtBread/matbot), available to enable in eidan. The agent uses it when you ask for something to happen "in the background" or "every N minutes/hours" — it should notify you that the task has started (and the output filename, if any) rather than wait for the result. It is node-only.

## Tools

| Tool | Purpose |
|------|---------|
| `background` | Run a prompt detached. Inputs: `prompt` (required); `interval` (a duration like `"30s"`, `"5m"`, `"1h"`, `"24h"` — omit, or pass `"once"`/null, to run a single time); `name` (optional label for recurring jobs); `output` (optional workspace filename to capture stdout, e.g. `"summary.md"` — otherwise stdout is discarded); `provider` (provider key, defaults to the current turn's provider). Returns `{ status: 'started' }` for run-once, or `{ id, interval }` for a schedule (the id is the management handle). |
| `every_action` | Manage recurring schedules. Inputs: `action` (`list` / `suspend` / `resume` / `cancel`) and `id`. `list` shows every schedule with id, interval, next run, and active state. `suspend`/`resume` accept `id: "*"` to act on all; `cancel` permanently deletes and requires a specific id (no bulk delete). Prefer `suspend` for a temporary pause. |

## Example

```
background({ prompt: "Summarise today's unread email", interval: "1h", output: "inbox.md" })
→ { id: "a1b2…", interval: "1h" }

every_action({ action: "list" })
→ [{ id: "a1b2…", interval: "1h", nextRun: "…", active: true, output: "inbox.md" }]
```

## Notes

- Requires the plugin to be set up with a config path; recurring jobs without one error out.
- Schedules persist in a `schedules` store and are re-armed on restart; startup is staggered (random delay) to avoid a pulse when many schedules are due at once.
- Spawned jobs set `IS_SUB_AGENT` so they do not arm their own scheduler (preventing exponential cascade).
- Do not wait for a background result — the user checks the output file themselves later.
