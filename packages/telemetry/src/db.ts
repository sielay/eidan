// SPDX-License-Identifier: AGPL-3.0-or-later
import pg from 'pg';

// Both eidan.node_heartbeats and eidan.node_events are cluster-global (keyed by node_id, no RLS),
// so this is a plain pool with no principal GUC. A small pool: a node writes one heartbeat every
// ~30s plus a trickle of activity events, so it must not add to the connection budget.
export class Db {
  readonly pool: pg.Pool;
  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 2 });
  }

  // Upsert this node's liveness row. node_id is the PK; the same node re-announces on every beat.
  async upsertHeartbeat(h: {
    nodeId: string;
    nodeType: string;
    status: string;
    plugins: unknown;
    servedKinds: unknown;
    metadata: unknown;
  }): Promise<void> {
    await this.pool.query(
      `insert into eidan.node_heartbeats
         (node_id, node_type, status, last_seen, plugins, served_kinds, metadata, created_at, updated_at)
       values ($1, $2, $3, now(), $4::jsonb, $5::jsonb, $6::jsonb, now(), now())
       on conflict (node_id) do update set
         node_type    = excluded.node_type,
         status       = excluded.status,
         last_seen    = now(),
         plugins      = excluded.plugins,
         served_kinds = excluded.served_kinds,
         metadata     = excluded.metadata,
         updated_at   = now()`,
      [h.nodeId, h.nodeType, h.status, JSON.stringify(h.plugins), JSON.stringify(h.servedKinds), JSON.stringify(h.metadata)],
    );
  }

  async markOffline(nodeId: string): Promise<void> {
    await this.pool.query(
      `update eidan.node_heartbeats set status = 'offline', updated_at = now() where node_id = $1`,
      [nodeId],
    );
  }

  // Mark nodes offline if last_seen is older than thresholdMs.
  // thresholdMs is guaranteed to be positive by calculateStaleThreshold.
  // Uses PostgreSQL-specific make_interval; equivalent logic: now() - last_seen > thresholdMs.
  async markStaleOffline(thresholdMs: number): Promise<void> {
    await this.pool.query(
      `update eidan.node_heartbeats
       set status = 'offline', updated_at = now()
       where status = 'online' and last_seen < now() - make_interval(milliseconds => $1)`,
      [Math.floor(thresholdMs)],
    );
  }

  // Append one activity event. seq is part of the (node_id, seq) PK with no DB default, so it is
  // generated per node as max+1 in the same statement. Concurrent appends on one node can collide
  // on the PK; retry a few times, then drop — telemetry must never throw into the turn pipeline.
  async emitEvent(e: {
    nodeId: string;
    type: string;
    payload: unknown;
    conversationId: string | null;
  }): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await this.pool.query(
          `insert into eidan.node_events (node_id, seq, ts, type, payload, conversation_id)
           select $1, coalesce(max(seq), 0) + 1, now(), $2, $3::jsonb, $4::uuid
             from eidan.node_events where node_id = $1`,
          [e.nodeId, e.type, JSON.stringify(e.payload), e.conversationId],
        );
        return;
      } catch (err) {
        // 23505 = unique_violation (two events raced for the same seq). Anything else is a real
        // failure (FK/connection) — log once and give up so we don't spin.
        if ((err as { code?: string }).code === '23505' && attempt < 3) continue;
        console.warn('[telemetry] emitEvent failed:', (err as Error).message);
        return;
      }
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
