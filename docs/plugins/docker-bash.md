# Docker Bash · matbot engine plugin

Replaces the plain `bash` tool with a sandboxed equivalent: scripts run inside a persistent Docker container (default `ubuntu:24.04`) via `docker exec`, with `stdout`/`stderr` streamed back in real time. The project root is mounted read-only at `/app` and `/app/.data` is read-write, so the agent can read the project but cannot mutate host source — its scratch space is confined to `.data`. The eidan agent uses it for the same jobs as `bash` (file work, builds, tests, package installs) whenever isolation from the host matters: it can `apt install` freely and make a mess inside a disposable container instead of on the host.

It is a plugin from the matbot engine (Apache-2.0, github.com/MatAtBread/matbot), available to enable in eidan. It is a node-runtime plugin that depends on the `bash` plugin and shells out to the Docker CLI. The container is created lazily on first use, reused across calls (matched by name), and left sleeping (`sleep infinity`) between commands.

## Tools

| Tool | Purpose |
|---|---|
| `bash` | Run a bash script inside the persistent container, executed as `bash -c <script>`, and stream output. Inputs: `script` (required); `env` (extra environment variables, passed only into the container — the host `process.env` is not leaked); `timeout` (milliseconds, after which the in-container process group is killed). Returns `{ exitCode, stdout, stderr }` on success; non-zero exit, timeout, abort, or output overflow each yield an `error` with the accumulated output. Combined `stdout`+`stderr` is capped (default 100 000 bytes); on exceed the process is killed. |
| `bash_config` | View or update the container configuration. `action: "get"` returns defaults/overrides/effective config; `action: "set"` persists overrides — `dns` (server IPs, or the token `"host"` for the host's current resolvers; `[]` inherits host DNS), `name` (container label), `maxOutputBytes` (per-command output cap); `action: "restart"` force-recreates the container now. Changing `dns`/`name` removes the running container so the next `bash` call rebuilds it; `maxOutputBytes` applies to subsequent commands without a restart. |

## Example

```
bash { "script": "apt-get update -q && apt-get install -y jq && jq --version" }
→ stdout streams… result: { exitCode: 0, stdout: "jq-1.7\n", stderr: "" }

bash_config { "action": "set", "dns": ["1.1.1.1"] }
→ result: container removed; next bash command recreates it with the new DNS

bash { "script": "echo build > /app/.data/out.txt && cat /app/.data/out.txt" }
→ result: { exitCode: 0, stdout: "build\n", stderr: "" }
```

## Notes

- Requires Docker — the Docker CLI must be installed and on PATH (a clear error is returned if not), with network access in the container so `apt` works (network defaults to Docker's bridge; configurable via `network`/`dns`).
- Sandbox boundary: the project root is mounted read-only at `/app`; only `/app/.data` is writable. Scripts run in `/app/.data/bash-cwd`. The host `process.env` is never passed in — only explicit `env` keys.
- The container persists across matbot restarts (reused by name, not reconciled at boot); use `bash_config` `restart` to recover a wedged container or to re-resolve a `"host"` DNS token after the host's resolvers change.
- On timeout/abort/overflow the whole in-container process group is killed (the script and every child), since `docker exec` does not propagate signals on its own.
