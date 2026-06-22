// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent tools for the `db` plugin — connect to the operator's named databases and run queries.
//
// Per-user, multi-connection: the operator registers named connections in the Integrations →
// Databases screen (driver + host/port/database/username + password). The non-secret coordinates
// live in plugin_db.connections; only the password is sealed in the vault. Each tool takes an
// optional `connection` name and resolves that connection's config + password per call.
//
// Four tools, deliberately split by shape rather than crammed into one polymorphic call:
//   db_list_connections — discover what's reachable (name, driver, host/database; no secrets)
//   db_inspect          — list a connection's tables (Postgres) / collections (Mongo)
//   db_query            — run SQL on a Postgres connection (full read/write)
//   db_mongo            — run a MongoDB command document on a Mongo connection (full read/write)
// db_query/db_mongo refuse a connection of the wrong driver and point the agent at the right tool.
import type { Tool } from '@matatbread/matbot-plugin-api';
import type { Registry } from './registry.js';
import { DbConfigError, resolveConnection } from './config.js';
import { inspector, mongoRunCommand, pgRunSql } from './drivers/index.js';

const CONNECTION_PROP = {
  connection: {
    type: 'string',
    description:
      'Which named database connection to use (from Integrations → Databases). Omit only when a ' +
      'single connection is registered. Call db_list_connections first if unsure.',
  },
};

const LIST_SCHEMA = { type: 'object', additionalProperties: false, properties: {} };

const INSPECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { ...CONNECTION_PROP },
};

const QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sql'],
  properties: {
    ...CONNECTION_PROP,
    sql: { type: 'string', description: 'SQL to run (read or write). Multiple statements allowed.', minLength: 1 },
    params: {
      type: 'array',
      description: 'Optional positional parameters for $1, $2, … placeholders (prevents injection).',
      items: {},
    },
  },
};

const MONGO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['command'],
  properties: {
    ...CONNECTION_PROP,
    command: {
      type: 'object',
      description:
        'A MongoDB command document run via db.command(). Reads: { find, filter, limit, sort }, ' +
        '{ aggregate, pipeline, cursor }, { count }. Writes: { insert, documents }, ' +
        '{ update, updates }, { delete, deletes }. The first key is the collection/operation.',
    },
  },
};

// Map a thrown error to a clean tool error. Config problems carry their guidance verbatim; driver
// errors surface the engine's own message so the agent can fix its query.
function errorMessage(e: unknown): string {
  if (e instanceof DbConfigError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

export function makeDbTools(registry: Registry): Tool[] {
  const dbListConnectionsTool: Tool = {
    name: 'db_list_connections',
    description:
      "List the operator's registered database connections (name, driver, host, database). No " +
      'passwords. Call this first to learn which `connection` names and drivers are available.',
    inputSchema: LIST_SCHEMA,
    executor: {
      async *execute() {
        const rows = await registry.listConnections();
        yield {
          type: 'result',
          value: {
            connections: rows.map((r) => ({
              name: r.name,
              driver: r.driver,
              host: r.host,
              port: r.port,
              database: r.database,
            })),
          },
        };
      },
    },
  };

  const dbInspectTool: Tool = {
    name: 'db_inspect',
    description:
      "List a connection's tables (Postgres) or collections (MongoDB) so you know what to query. " +
      'Pass `connection` to choose among several.',
    inputSchema: INSPECT_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { connection?: string };
        try {
          const { row, password } = await resolveConnection(registry, ctx, args.connection);
          const result = await inspector(row.driver)(row, password, ctx.signal);
          yield { type: 'result', value: { connection: row.name, ...result } };
        } catch (e) {
          yield { type: 'error', message: errorMessage(e) };
        }
      },
    },
  };

  const dbQueryTool: Tool = {
    name: 'db_query',
    description:
      'Run SQL against a Postgres connection (full read/write — SELECT/INSERT/UPDATE/DELETE/DDL). ' +
      'Returns rows (capped at 1000), row count and command per statement. Use $1/$2 placeholders ' +
      'with `params` for any user-supplied values. For MongoDB connections use db_mongo instead.',
    inputSchema: QUERY_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { connection?: string; sql?: string; params?: unknown[] };
        const sql = String(args.sql ?? '').trim();
        if (!sql) {
          yield { type: 'error', message: 'sql is required' };
          return;
        }
        try {
          const { row, password } = await resolveConnection(registry, ctx, args.connection);
          if (row.driver !== 'postgres') {
            yield { type: 'error', message: `"${row.name}" is a ${row.driver} connection — use db_mongo for it.` };
            return;
          }
          const params = Array.isArray(args.params) ? args.params : [];
          const out = await pgRunSql(row, password, sql, params, ctx.signal);
          yield { type: 'result', value: { connection: row.name, ...out } };
        } catch (e) {
          yield { type: 'error', message: errorMessage(e) };
        }
      },
    },
  };

  const dbMongoTool: Tool = {
    name: 'db_mongo',
    description:
      'Run a MongoDB command document against a Mongo connection (full read/write via db.command). ' +
      'E.g. { find: "users", filter: { active: true }, limit: 10 } or { insert: "users", documents: ' +
      '[…] }. Returns the raw command result. For Postgres connections use db_query instead.',
    inputSchema: MONGO_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { connection?: string; command?: unknown };
        const command = args.command;
        if (!command || typeof command !== 'object' || Array.isArray(command)) {
          yield { type: 'error', message: 'command must be a MongoDB command document (object)' };
          return;
        }
        try {
          const { row, password } = await resolveConnection(registry, ctx, args.connection);
          if (row.driver !== 'mongodb') {
            yield { type: 'error', message: `"${row.name}" is a ${row.driver} connection — use db_query for it.` };
            return;
          }
          const result = await mongoRunCommand(row, password, command as Record<string, unknown>, ctx.signal);
          yield { type: 'result', value: { connection: row.name, result } };
        } catch (e) {
          yield { type: 'error', message: errorMessage(e) };
        }
      },
    },
  };

  return [dbListConnectionsTool, dbInspectTool, dbQueryTool, dbMongoTool];
}
