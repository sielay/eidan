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
import { inspector, mongoRunCommand, pgRunSql, pgIntrospect } from './drivers/index.js';

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
  properties: {
    ...CONNECTION_PROP,
    schema: {
      type: 'string',
      description: 'Postgres only: limit the listed tables to this one schema. Omit to list every ' +
        'non-system schema (returned in `schemas`) and all their tables.',
    },
  },
};

const QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...CONNECTION_PROP,
    action: {
      type: 'string',
      enum: ['query', 'introspect'],
      description: 'Either "query" to run SQL, or "introspect" to discover database structure ' +
        '(tables, columns, types, row counts). Default is "query".',
    },
    sql: { type: 'string', description: 'SQL to run (read or write). Multiple statements allowed. Required when action is "query".', minLength: 1 },
    tables: {
      type: 'array',
      description: 'Postgres only: when action is "introspect", filter to tables matching these patterns ' +
        '(supports * and ? wildcards, e.g. ["ventures", "xero_*"]). Omit to list all accessible tables.',
      items: { type: 'string' },
    },
    schema: {
      type: 'string',
      description: 'Postgres only: set search_path to this schema for the query, so unqualified table ' +
        'names resolve there (fully-qualified names like other_schema.t still work). Omit for the default.',
    },
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
      "List a connection's schemas + tables (Postgres) or collections (MongoDB) so you know what to " +
      'query. For Postgres, `schemas` lists every non-system namespace; pass `schema` to scope the ' +
      'tables to one. Pass `connection` to choose among several.',
    inputSchema: INSPECT_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { connection?: string; schema?: string };
        try {
          const { row, password } = await resolveConnection(registry, ctx, args.connection);
          const result = await inspector(row.driver)(row, password, ctx.signal, args.schema);
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
      'Run SQL against a Postgres connection (full read/write — SELECT/INSERT/UPDATE/DELETE/DDL), or introspect database structure. ' +
      'For queries: returns rows (capped at 1000), row count and command per statement. Use $1/$2 placeholders ' +
      'with `params` for any user-supplied values. Pass `schema` to resolve unqualified table names. ' +
      'For introspection: discovers tables, columns, types, row counts, indexes, and foreign keys (RLS-scoped). ' +
      'For MongoDB connections use db_mongo instead.',
    inputSchema: QUERY_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as {
          connection?: string;
          action?: string;
          sql?: string;
          schema?: string;
          params?: unknown[];
          tables?: string[];
        };
        const action = (args.action ?? 'query').toLowerCase();

        if (action !== 'query' && action !== 'introspect') {
          yield { type: 'error', message: 'action must be either "query" or "introspect"' };
          return;
        }

        try {
          const { row, password } = await resolveConnection(registry, ctx, args.connection);
          if (row.driver !== 'postgres') {
            yield { type: 'error', message: `"${row.name}" is a ${row.driver} connection — use db_query for Postgres or db_mongo for MongoDB.` };
            return;
          }

          if (action === 'introspect') {
            const out = await pgIntrospect(row, password, ctx.signal, args.tables);
            yield { type: 'result', value: { connection: row.name, ...out } };
          } else {
            const sql = String(args.sql ?? '').trim();
            if (!sql) {
              yield { type: 'error', message: 'sql is required when action is "query"' };
              return;
            }
            const params = Array.isArray(args.params) ? args.params : [];
            const out = await pgRunSql(row, password, sql, params, ctx.signal, args.schema);
            yield { type: 'result', value: { connection: row.name, ...out } };
          }
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
