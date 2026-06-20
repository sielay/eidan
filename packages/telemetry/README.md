# @eidandev/telemetry

Always-on node telemetry. It is the writer for the two cluster-global tables the admin UI reads but
nothing else populates:

- **`eidan.node_heartbeats`** — one row per node (PK `node_id`). Upserted on boot and every 30s with
  `status='online'`, fresh `last_seen`, `node_type`, the node's tool list (`plugins`), its served job
  kinds (`served_kinds`, from `EIDAN_JOB_KINDS`), and `metadata` (host/pid/startedAt). Set to
  `offline` on graceful teardown. Drives the dashboard's node count and the **Nodes** view.
- **`eidan.node_events`** — the append-only activity stream behind the **log / live** panes. A
  `screen` hook emits a `turn` event per turn; a `toolresult` hook emits a `tool` event (name,
  duration, error) per tool call; plus `node.online` / `node.offline` lifecycle events. `seq` is
  generated per node as `max+1` (it is part of the `(node_id, seq)` PK with no DB default).

## Node identity

- `node_id` = `EIDAN_NODE_ID`, else `mb-<hostname>`.
- `node_type` = `EIDAN_NODE_TYPE`, else `fly` when `FLY_APP_NAME` is set, else `node`.

## Design notes

- Cluster-global, no RLS — a plain `pg.Pool` (`max: 2`), no principal GUC.
- Activity hooks are fire-and-forget observers: they never await and never throw into a turn, so a DB
  hiccup degrades telemetry, never the conversation.
- `node_events.conversation_id` is only attached when `session.id` is a real uuid.
- Requires `EIDAN_DATABASE_URL` (or `DATABASE_URL`); without it the plugin disables itself quietly.
