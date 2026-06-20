# Bash · matbot engine plugin

Runs bash scripts on the host, in the session workspace, streaming `stdout`/`stderr` back in real time as they are produced. The eidan agent uses it for any shell automation a task implies: file operations, build steps, running tests, installing packages, or invoking command-line tools that have no dedicated tool of their own. Output streams line by line, and a non-zero exit code comes back as an error event with the accumulated `stdout`/`stderr` attached so the agent can diagnose and self-correct.

It is a plugin from the matbot engine (Apache-2.0, github.com/MatAtBread/matbot), available to enable in eidan. It is a node-runtime tool that spawns a real local shell — there is no container isolation (for a sandboxed variant see the `docker-bash` plugin, which exposes the same `bash` tool name backed by a container).

## Tools

| Tool | Purpose |
|---|---|
| `bash` | Run a bash script or command, executed as `bash -c <script>`, and stream output. Inputs: `script` (required); `cwd` (working directory — defaults to the session workspace, created if missing); `env` (extra environment variables, merged on top of the process environment); `timeout` (milliseconds, after which the process is sent SIGTERM). Returns a `result` of `{ exitCode, stdout, stderr }` on success; a non-zero exit yields an `error` with the code and the captured output. |

## Example

```
bash { "script": "npm test 2>&1 | tail -n 20" }
→ stdout streams… then result: { exitCode: 0, stdout: "…", stderr: "" }

bash { "script": "ls *.csv | wc -l", "cwd": "data", "timeout": 5000 }
→ result: { exitCode: 0, stdout: "3\n", stderr: "" }
```

## Notes

- Requires filesystem and process-execution capability — it spawns a local `bash` process via Node's `child_process`, so `bash` must be on PATH (node runtime only).
- No sandboxing: scripts run with the host process's privileges and inherit the full process environment (then `env` is layered on top). Anything the agent can express in a shell runs directly on the host. Use `docker-bash` when isolation matters.
- The working directory defaults to the session workspace (`ctx.workdir`); a relative or absolute `cwd` overrides it and is created recursively if absent.
- `timeout` kills via SIGTERM; an aborted tool call also SIGTERMs the child.
