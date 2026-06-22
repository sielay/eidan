// SPDX-License-Identifier: AGPL-3.0-or-later
// Driver abstraction for the `db` plugin. Each driver knows how to open a short-lived connection
// from a registry row + its vault password, introspect the schema, and execute a unit of work. The
// tool layer dispatches on `row.driver`; adding a database engine is a new module here plus a case
// in the dispatch maps below — nothing in the registry/tool layer changes. Postgres and MongoDB
// ship first (the operator's brief); MySQL/SQLite/etc. slot in the same way.
import type { ConnectionRow, Driver } from '../registry.js';
import { pgInspect, pgPing, pgRunSql } from './postgres.js';
import { mongoInspect, mongoPing, mongoRunCommand } from './mongodb.js';

// What `db_inspect` returns, normalised across engines: a flat list of "containers" (Postgres
// tables, Mongo collections) the agent can then query.
export interface InspectResult {
  driver: Driver;
  containers: Array<{ schema?: string; name: string; kind: string }>;
}

export type Inspector = (row: ConnectionRow, password: string, signal: AbortSignal) => Promise<InspectResult>;

const INSPECTORS: Record<Driver, Inspector> = {
  postgres: pgInspect,
  mongodb: mongoInspect,
};

export function inspector(driver: Driver): Inspector {
  return INSPECTORS[driver];
}

// A connection liveness/credentials probe per driver. Resolves on success, throws on failure.
export type Pinger = (row: ConnectionRow, password: string, signal: AbortSignal) => Promise<void>;

const PINGERS: Record<Driver, Pinger> = {
  postgres: pgPing,
  mongodb: mongoPing,
};

export function pinger(driver: Driver): Pinger {
  return PINGERS[driver];
}

export { pgRunSql, mongoRunCommand };
