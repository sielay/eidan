# 024 — Node telemetry

Status: Draft

Owner: Core

Related: [ARCHITECTURE](./ARCHITECTURE.md) (multi-instance topology),
[DEPLOYMENT](./DEPLOYMENT.md) (per-platform recipes),
[003 — Memory DDL](./003_MEMORY_DDL.md) (sibling core tables),
[021 — Cross-instance dispatch](./021_CROSS_INSTANCE_DISPATCH.md)
(leader election uses the same node identity).

This document specifies eidan's **per-node telemetry surface** —
the heartbeat + event-stream pair every backend process writes to
the shared Postgres so an operator (or an agent acting on behalf
of the operator) can answer "which nodes are alive, and what is
each one doing right now?".

Modelled on the potem stack's `private.agent_heartbeats` +
`private.node_events` pattern (`apps/pi-node` writer + `apps/web`
reader). Carried into eidan with two differences:

- `conversation_id` (eidan's unit of work) replaces potem's
  `job_id`. Nullable — scheduler ticks, plugin lifecycle events,
  and boot/shutdown rows don't belong to a conversation.
- Tables live in the shared `eidan` schema, not a separate
  `private` schema. Eidan doesn't have potem's `service_role` vs
  `anon` split; access is gated at the HTTP route, not via RLS,
  because node identity is host-global (no `user_id` column).

Telemetry has one **invariant: it must never break job execution.**
Both writes (heartbeat UPSERT, event append) catch every exception
and log it; the next 30 s heartbeat tries again, an event-write
that fails is lost on purpose.

---

## 1. Node identity

Every backend process owns one `NodeIdentity` — see
[`apps/backend/eidan_backend/node_identity.py`](../apps/backend/eidan_backend/node_identity.py).

```python
@dataclass(frozen=True, slots=True)
class NodeIdentity:
    node_id: str            # PK on node_heartbeats
    node_type: str          # one of: pi | fly | heroku | k8s | local
    metadata: dict[str, Any]
```

Resolution order, highest precedence first:

1. **`EIDAN_NODE_ID`** / **`EIDAN_NODE_TYPE`** env vars — operator
   override, always wins. `EIDAN_NODE_TYPE` is validated against
   the allow-list; an invalid value (typo, unknown platform) falls
   through to auto-detection so the CHECK constraint on
   `node_heartbeats.node_type` never fires.
2. **Platform fingerprint**, first hit wins:
   - `FLY_MACHINE_ID` set → `node_type=fly`. `metadata` picks up
     `fly_app` (`FLY_APP_NAME`), `fly_region` (`FLY_REGION`),
     `fly_image_ref` (`FLY_IMAGE_REF`), `fly_alloc_id`
     (`FLY_ALLOC_ID`) when present.
   - `DYNO` set → `node_type=heroku`, `node_id=heroku-{DYNO}`.
     Heroku's dyno hostnames rotate on every restart, so the dyno
     *name* is the stable-ish identifier.
   - `KUBERNETES_SERVICE_HOST` set → `node_type=k8s`,
     `node_id={hostname}`. The pod name is stable enough as long
     as the deployment uses a StatefulSet or operators set
     `EIDAN_NODE_ID` explicitly. With a Deployment, pod hostnames
     roll and each new pod registers fresh.
   - `platform.machine() == 'aarch64'` → `node_type=pi`,
     `node_id={short hostname}`.
3. **Fallback** — short hostname, `node_type=local`. Always
   succeeds.

`metadata` always carries `hostname`, `platform`, and `python`
across every detector; per-platform keys layer on top.

Detection is pure-Python with no DB or network calls. It runs once
per process at the bootstrap entry point and the result is cached
on the `BootstrapResult` and `app.state` for the rest of the
process lifetime.

### 1.1 Why the override exists

Two real-world reasons an operator pins identity by env:

- **Multiple processes on one host.** A Pi running both a long-lived
  worker and an ad-hoc REPL would otherwise share one `node_id` and
  trample each other's heartbeats. Pin each with
  `EIDAN_NODE_ID=pi-kasha-worker` / `EIDAN_NODE_ID=pi-kasha-repl`.
- **Reclassification.** A Fly machine functionally serving as a
  background worker (Sentry tick host, future Claude Code worker)
  can be regrouped as `EIDAN_NODE_TYPE=pi` so the dashboard puts it
  alongside the real Pi.

---

## 2. Tables

Defined in
[`migrations/versions/20260523_000001_init_node_telemetry.py`](../migrations/versions/20260523_000001_init_node_telemetry.py).
Both tables live in the `eidan` schema and have **no RLS** —
identity is host-global.

### 2.1 `eidan.node_heartbeats`

| Column      | Type          | Notes                                              |
|-------------|---------------|----------------------------------------------------|
| `node_id`   | `text` PK     | Stable per-process identifier (see §1).            |
| `node_type` | `text`        | CHECK: `pi | fly | heroku | k8s | local`.          |
| `status`    | `text`        | CHECK: `online | offline | degraded`. Default `online`. |
| `last_seen` | `timestamptz` | Touched on every UPSERT.                           |
| `metadata`  | `jsonb`       | Platform fingerprint (region, app, namespace, …).  |
| `created_at`/`updated_at` | `timestamptz` | Conventions per [003 §1.2](./003_MEMORY_DDL.md). `set_updated_at` trigger. |

**Posture:** mutable. UPSERTed every 30 s while the process runs.
A node that crashes or is killed leaves its row at the last
`last_seen` — the read path interprets `now() - last_seen >
threshold` as "offline" without touching the row. No DB-side
cleanup; the trail persists for post-mortem.

**Indexes:**
- PK on `node_id`.
- `node_heartbeats_last_seen_idx` on `last_seen DESC` — drives the
  default dashboard sort (live first).

### 2.2 `eidan.node_events`

| Column            | Type          | Notes                                                                          |
|-------------------|---------------|--------------------------------------------------------------------------------|
| `node_id`         | `text`        | FK → `node_heartbeats(node_id)` `ON DELETE CASCADE`.                           |
| `seq`             | `bigint`      | Per-node monotonically increasing. Allocated by the emitter under an advisory lock. |
| `ts`              | `timestamptz` | Default `now()`.                                                               |
| `type`            | `text`        | Free-form lowercase dotted (e.g. `node.boot`, `plugin.activate`).              |
| `payload`         | `jsonb`       | Whatever context the emitter captures.                                         |
| `conversation_id` | `uuid` null   | Optional FK-soft reference to `eidan.conversations.id` (no constraint).        |
| Primary key       | `(node_id, seq)` |                                                                              |

**Posture:** immutable. Matches `llm_calls` — retention is a
separate purge-job concern, not a TTL on the table. No `deleted_at`.

`seq` is per-node, not global. Lets `/api/admin/nodes/{id}/events?after_seq=N`
support incremental polling identically across nodes. Allocated by the
emitter via `SELECT MAX(seq)+1` inside a per-node `pg_advisory_xact_lock`
(class `0x65696461` = ASCII "eida") so concurrent writers from
the same node don't race for the same seq.

**Indexes:**
- PK on `(node_id, seq)`.
- `node_events_node_seq_idx` on `(node_id, seq DESC)` — default tail query.
- `node_events_node_ts_idx` on `(node_id, ts DESC)` — human-time-window queries.
- `node_events_node_conversation_seq_idx` on `(node_id, conversation_id, seq)` partial `WHERE conversation_id IS NOT NULL` — conversation-scoped slice. Composite matches the §5.2 query's `WHERE node_id = $1 AND conversation_id = $2 AND seq > $3 ORDER BY seq` so the planner satisfies the whole route off the index alone.

No FK from `conversation_id` to `eidan.conversations(id)`: a
conversation can be soft-deleted; the event trail must survive.

---

## 3. Emitter

Defined in
[`apps/backend/eidan_backend/telemetry.py`](../apps/backend/eidan_backend/telemetry.py).

```python
class TelemetryEmitter:
    def __init__(self, pool, identity, *, heartbeat_interval_seconds=30): ...
    async def start() -> None  # eager first heartbeat + background loop
    async def stop()  -> None  # cancel loop; does NOT mark row offline
    async def emit_event(event_type: str, payload: dict | None = None,
                         *, conversation_id: UUID | str | None = None) -> None
```

One instance per process. Constructed and started by `bootstrap()`
([`apps/backend/eidan_backend/bootstrap.py`](../apps/backend/eidan_backend/bootstrap.py)),
stopped by `shutdown()`, stashed on `app.state.telemetry` so HTTP
routes can reach it.

The **eager first heartbeat** matters: a fresh process has no
`node_heartbeats` row yet, and `node_events.node_id` FKs into it.
Without the eager beat, the first `emit_event` would raise 23503.
`start()` writes the heartbeat synchronously before scheduling the
loop, so the FK is satisfied by the time any event lands.

`stop()` does **not** mark the heartbeat row offline. A clean
shutdown is indistinguishable from a kill -9 at the read path's
"last_seen older than threshold" check — the dashboard renders
"offline" for any row whose `last_seen` is more than ~2× the
heartbeat interval old. Keeps the code simple and avoids
"shutdown handler raced with SIGKILL" foot-guns.

### 3.1 Failure handling

Both `_upsert_heartbeat` and `emit_event` wrap the entire DB op
in `try / except Exception` and call `logger.exception(...)`. The
caller sees nothing. The next 30 s heartbeat retries; events that
fail are lost on purpose. This matches potem's `_append_node_event`
posture verbatim — telemetry is observability, not contract data.

### 3.2 stdout mirror

Every `emit_event` *also* fires a structured `logging.info`
line via `eidan_backend.telemetry`'s module logger with `extra=`
fields:

```
event=plugin.activate node_id=pi-kasha node_type=pi
conversation_id=None payload={'plugin': 'sentry', 'version': '0.1.0'}
```

`journalctl -u eidan-backend` and `fly logs -a eidan-api` thus
carry the same trail as the DB. External aggregators (BetterStack,
Loki, Datadog) bolt on as logging handlers — see §6.

---

## 4. Event types

Lowercase dotted. Core emits the following from `bootstrap()` and
`shutdown()`:

| Type                  | When                                                | Payload                                           |
|-----------------------|-----------------------------------------------------|---------------------------------------------------|
| `node.boot`           | Last bootstrap step before returning.               | `{plugins[], tool_count, metadata}`               |
| `node.shutdown`       | First shutdown step.                                | `{plugins[]}`                                     |
| `plugin.activate`     | One per loaded plugin, after `on_activate` hooks.   | `{plugin, version}`                               |
| `dispatcher.started`  | Once, when the behaviour dispatcher starts.         | `{cron_jobs}`                                     |

Plugins and the agentic loop **may** emit their own types. The
type string is free-form; convention is `<area>.<verb>` (e.g.
`sentry.tick`, `provider.error`, `behaviour.fired`). Plugin
authors who want telemetry access today can pull the emitter via
`request.app.state.telemetry` from an HTTP handler or — once
[001 — Plugins](./001_PLUGINS.md) lands the surface — through
`PluginContext`.

---

## 5. Read surface

Two routes in
[`apps/backend/eidan_backend/http/routes.py`](../apps/backend/eidan_backend/http/routes.py).
Both gated on a valid session via the auth middleware; the table
itself has no `user_id`, so `acquire(pool, identity)` is **not**
used (it would open an unnecessary RLS-scoped transaction).

### 5.1 `GET /api/admin/nodes`

```jsonc
{
  "nodes": [
    {
      "node_id": "pi-kasha",
      "node_type": "pi",
      "status": "online",
      "last_seen": "2026-05-23T22:30:00+00:00",
      "seconds_since": 7,
      "metadata": {"hostname": "kasha", "platform": "Linux-..."},
      "created_at": "...",
      "updated_at": "..."
    },
    {
      "node_id": "m-fly-abc123",
      "node_type": "fly",
      "status": "online",
      "last_seen": "...",
      "seconds_since": 12,
      "metadata": {"fly_app": "eidan-api", "fly_region": "lhr"},
      ...
    }
  ]
}
```

Ordered by `last_seen DESC` so the live nodes float to the top.
`seconds_since` is computed in SQL (`EXTRACT(EPOCH FROM (now() -
last_seen))::int`) so the UI doesn't need to negotiate clock skew
with the server.

### 5.2 `GET /api/admin/nodes/{node_id}/events`

| Query param        | Default | Meaning                                                                   |
|--------------------|---------|---------------------------------------------------------------------------|
| `after_seq`        | 0       | Return only events with `seq > after_seq`. Drives incremental polling.    |
| `conversation_id`  | null    | Filter to one conversation's slice. When set, results are ASC (chronological); else DESC (latest first). |
| `limit`            | 200     | Capped at 500.                                                            |

Returns `404 unknown node_id` when the path's `node_id` has never
heartbeated. An empty `events` array is a valid response — node
exists, just hasn't emitted past `after_seq`.

```jsonc
{
  "node_id": "pi-kasha",
  "events": [
    {
      "id": "pi-kasha:42",            // "{node_id}:{seq}" — same as potem
      "seq": 42,
      "ts": "2026-05-23T22:30:00+00:00",
      "type": "node.boot",
      "payload": {"plugins": ["sentry"], "tool_count": 8, "metadata": {...}},
      "conversation_id": null
    }
    // ... DESC, newest first
  ]
}
```

---

## 6. External log forwarding

Core ships a built-in HTTP/JSON forwarder in
[`apps/backend/eidan_backend/log_forwarding.py`](../apps/backend/eidan_backend/log_forwarding.py).
The operator's surface is pure env-config in `/etc/eidan/eidan.env`
— no Python file to drop, no `PYTHONPATH`, no `sitecustomize.py`,
nothing to write under `/opt/eidan/`. This respects the no-fork
distribution model ([018](./018_DISTRIBUTION_AND_BUNDLES.md)):
operators only ever touch their env file; core code is read-only
on the host.

### 6.1 Env vars

| Var                          | Required | Effect |
|------------------------------|----------|--------|
| `EIDAN_LOG_FORWARD_URL`      | Yes (to enable) | HTTP intake URL. Forwarder is off when unset. |
| `EIDAN_LOG_FORWARD_TOKEN`    | No       | Sent as `Authorization: Bearer <token>` — common BetterStack / Axiom / Honeycomb shape. |
| `EIDAN_LOG_FORWARD_HEADERS`  | No       | JSON-encoded dict of extra headers, merged on top. Escape hatch for non-Bearer auth (Datadog's `DD-API-KEY`, custom routing headers). |
| `EIDAN_LOG_FORWARD_LEVEL`    | No       | Minimum level the forwarder's handler accepts; default `INFO`. **Effective forwarded threshold is `max(root_logger_level, EIDAN_LOG_FORWARD_LEVEL)`** — see the note below. Set to `WARNING` to keep the intake quieter. |
| `EIDAN_LOG_FORWARD_TIMEOUT`  | No       | HTTP POST timeout in seconds; default `5.0`. Failures are swallowed (printed to stderr); the next log line tries again. |
| `EIDAN_LOG_FORWARD_QUEUE_SIZE` | No     | Max in-process buffer size; default `10000`. When the intake stalls, records past this cap are dropped. Stderr surfaces the **first** drop of a streak, then every 100, plus a "queue accepted" line when the listener catches up — so brief queue fills are immediately visible. Prevents OOM under a hanging intake while keeping the "telemetry never breaks job execution" posture. |

The forwarder attaches at boot from
[`http/app.py`'s lifespan](../apps/backend/eidan_backend/http/app.py)
before the pool is created, so the early boot lines (DB connect,
plugin activate, telemetry `node.boot`) land in the intake too.

> **Root-logger gating.** Python's logging stack filters records
> at the root logger's effective level *before* any handler runs.
> The forwarder deliberately does not mutate the root level — that
> would surprise stdout/journald and any other handler the
> operator has wired up. Net effect: the threshold actually
> forwarded is `max(root_logger_level, EIDAN_LOG_FORWARD_LEVEL)`.
>
> In the standard `eidan-backend-http` / `eidan admin server`
> deployment, the operator's lever for root level is **another
> env var, `EIDAN_HTTP_LOG_LEVEL`** (default `info`, see
> [`HttpSettings.log_level`](../apps/backend/eidan_backend/config.py)).
> The HTTP entry point's log-config builder lifts the root logger
> to that level when it constructs uvicorn's `dictConfig` (see
> [`http/server.py:_build_log_config`](../apps/backend/eidan_backend/http/server.py)),
> so the no-fork / env-only operator model is intact — there's no
> need to edit unit files, pass uvicorn CLI flags, or write a
> `logging.basicConfig` shim. One edge: if `EIDAN_HTTP_LOG_FILE`
> is set to the empty string (file logging disabled), the custom
> log config isn't built and uvicorn's stock config keeps root at
> `WARNING`; in that case the forwarder will only see WARNING+
> records regardless of `EIDAN_LOG_FORWARD_LEVEL`. Likewise, a
> logger configured with `propagate=False` won't reach root at
> all, so its records are not in scope regardless of level.

### 6.2 JSON envelope

One POST per log record. Body is a flat JSON object:

```json
{
  "ts":      "2026-05-24T08:30:00.123+00:00",
  "level":   "INFO",
  "logger":  "eidan_backend.telemetry",
  "message": "telemetry: node.boot",
  "event":   "node.boot",
  "node_id": "kasha",
  "node_type": "pi",
  "payload": {"plugins": ["sentry"], "tool_count": 4}
}
```

`event` / `node_id` / `node_type` / `conversation_id` / `payload`
come from the telemetry emitter's `extra=` kwargs (see §3.2) and
are **only included when non-null**. The example above is for a
node-level event (no conversation); a turn-bound event would
carry `"conversation_id": "<uuid>"`. Records that didn't go
through the telemetry path (raw stdlib logs from asyncpg,
uvicorn) ship with just the four stdlib fields and `exception`
when present.

### 6.3 BetterStack (Logtail)

```ini
# /etc/eidan/eidan.env
EIDAN_LOG_FORWARD_URL=https://in.logs.betterstack.com
EIDAN_LOG_FORWARD_TOKEN=<your-source-token>
```

Logtail accepts the flat JSON shape directly. The `event=` /
`node_id=` / etc. keys land as top-level searchable attributes.

### 6.4 Datadog

```ini
EIDAN_LOG_FORWARD_URL=https://http-intake.logs.datadoghq.com/api/v2/logs
EIDAN_LOG_FORWARD_HEADERS={"DD-API-KEY":"<your-api-key>"}
```

Datadog uses `DD-API-KEY` instead of `Authorization: Bearer`, so
the auth header goes through `EIDAN_LOG_FORWARD_HEADERS` rather
than `EIDAN_LOG_FORWARD_TOKEN`.

**systemd-`EnvironmentFile=` quoting.** systemd splits unquoted
values on whitespace, so JSON with spaces gets truncated. Two
safe shapes:

- Drop the spaces, as above (`{"DD-API-KEY":"<key>"}`). Valid
  JSON, parses identically.
- Single-quote the whole value if you keep the spaces:
  `EIDAN_LOG_FORWARD_HEADERS='{"DD-API-KEY": "<key>"}'`.

If you `source /etc/eidan/eidan.env` into a shell, both shapes
also work for `export`.

### 6.5 Loki

Loki's push API expects a specific envelope shape (`{"streams":
[{"stream": {...}, "values": [["ts_ns", "log_line"]]}]}`) that
doesn't match the flat object §6.2 ships. Two options for Loki
deployments:

- **Recommended:** point eidan at a relay (Vector, Fluent Bit,
  Promtail with `pipeline_stages: [json]`) that accepts the flat
  JSON and reshapes it for Loki's intake. Vector's `http_server`
  source + `loki` sink is six YAML lines. Keeps eidan's env
  contract simple.
- **Alternative:** disable the forwarder (leave `EIDAN_LOG_FORWARD_URL`
  unset) and scrape `journalctl -u eidan-backend` from Promtail's
  `systemd_journal` source. Lets Loki do the shape transformation
  in its own pipeline. The trade-off: no auth on the wire, scraper
  must live on the same host.

### 6.6 Any HTTP intake

Axiom, Honeycomb, custom webhooks, an in-house ELK ingestion
endpoint — any URL that accepts POST + JSON works. Set `URL` +
whatever auth the intake wants (Bearer via `TOKEN`, otherwise via
`HEADERS`).

### 6.7 Why a built-in forwarder (vs picking an SDK)

The stdlib `urllib.request` + JSON envelope path covers every
intake that accepts POST. Vendor SDKs (`logtail-python`, `datadog`,
`opentelemetry-sdk`) add per-vendor buffering / retries / shape
transformation, but the cost is:

- **A new core dep per vendor** the doc has to keep current as
  the SDK ages.
- **Vendor lock-in** for operators who'd otherwise just point at a
  generic HTTPS endpoint.
- **Operator-edits-core** if we ask operators to install the SDK
  themselves and wire it via `sitecustomize.py` — explicitly
  forbidden by the no-fork distribution model.

The built-in forwarder accepts the trade — flat JSON + stdlib
sockets, no batching beyond Python's internal queue, retries are
"next log line will try again". An operator who needs vendor-SDK
features can run a relay (Vector / Fluent Bit) between eidan and
the intake and configure the SDK there, where vendor coupling
doesn't reach core.

---

## 7. Retention

Same posture as `llm_calls` ([CLAUDE.md](../CLAUDE.md) →
*Conventions*): `node_events` is immutable, no TTL. Retention is a
separate purge job concern.

Why not a TTL today: we don't yet know what the steady-state event
volume looks like on a real deployment. Picking a TTL before we
know burns design budget. The right cleanup shape (cron-driven
`DELETE WHERE ts < now() - interval`, or a partitioning scheme by
day/week, or per-node row caps) depends on what actually hurts.

When it does hurt, the cleanup lands as a small core plugin or a
behaviour, not a schema change.

---

## 8. Open questions

- **PluginContext access.** Plugins currently can't reach the
  emitter directly — they'd have to import `app.state` from an
  HTTP handler. Should `PluginContext.telemetry` be added? Cheap
  but cross-cutting (touches the [001](./001_PLUGINS.md) plugin
  contract).
- **Sentry tick events.** The sentry plugin doesn't currently emit
  `sentry.tick` even though those would be the highest-signal
  rows in `node_events`. Held off until [001](./001_PLUGINS.md)
  adds `ctx.telemetry`.
- **Provider error events.** `llm_calls.error` already records
  per-call failures. Mirroring those into `node_events` as
  `provider.error` would duplicate the row but make the node-level
  tail self-contained. Open.
- **Mark-offline on graceful shutdown.** §3 explicitly skips this.
  Worth revisiting if "x just restarted vs x crashed" matters
  diagnostically — would need a `degraded` post-stop state that
  resolves to `offline` on the next read-path threshold check.
