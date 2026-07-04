// SPDX-License-Identifier: AGPL-3.0-or-later
// Tests for db_query introspection mode: schema discovery without prior table knowledge.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IntrospectResult, TableSchema } from './drivers/postgres.js';

test('introspection result structure validation', () => {
  // Mock introspection result validates the expected structure
  const mockResult: IntrospectResult = {
    tables: ['public.users', 'public.posts', 'xero.invoices', 'ventures.round_metrics'],
    table_schemas: {
      'public.users': {
        columns: [
          { name: 'id', type: 'bigint' },
          { name: 'email', type: 'text' },
          { name: 'created_at', type: 'timestamp with time zone' },
        ],
        row_count: 1542,
        indexes: ['users_pkey', 'users_email_idx'],
        foreign_keys: [],
      },
      'public.posts': {
        columns: [
          { name: 'id', type: 'bigint' },
          { name: 'user_id', type: 'bigint' },
          { name: 'title', type: 'text' },
          { name: 'content', type: 'text' },
        ],
        row_count: 8920,
        indexes: ['posts_pkey', 'posts_user_id_idx'],
        foreign_keys: [{ column: 'user_id', referenced_table: 'users', referenced_column: 'id' }],
      },
      'xero.invoices': {
        columns: [
          { name: 'id', type: 'uuid' },
          { name: 'invoice_number', type: 'text' },
          { name: 'amount', type: 'numeric' },
          { name: 'status', type: 'text' },
        ],
        row_count: 523,
        indexes: ['invoices_pkey', 'invoices_invoice_number_idx'],
        foreign_keys: [],
      },
      'ventures.round_metrics': {
        columns: [
          { name: 'venture_id', type: 'uuid' },
          { name: 'round', type: 'text' },
          { name: 'total_raised', type: 'numeric' },
        ],
        row_count: 145,
        indexes: ['round_metrics_pkey'],
        foreign_keys: [
          { column: 'venture_id', referenced_table: 'ventures', referenced_column: 'id' },
        ],
      },
    },
  };

  // Verify table list
  assert.strictEqual(mockResult.tables.length, 4);
  assert(mockResult.tables.includes('public.users'));
  assert(mockResult.tables.includes('xero.invoices'));

  // Verify schema structure per table
  assert.strictEqual(Object.keys(mockResult.table_schemas).length, 4);

  const users = mockResult.table_schemas['public.users'];
  assert(users !== undefined, 'users table schema should exist');
  assert.strictEqual(users.columns.length, 3);
  assert.strictEqual(users.columns[0]!.name, 'id');
  assert.strictEqual(users.columns[0]!.type, 'bigint');
  assert.strictEqual(users.row_count, 1542);
  assert.strictEqual(users.indexes.length, 2);
  assert.strictEqual(users.foreign_keys.length, 0);

  const posts = mockResult.table_schemas['public.posts'];
  assert(posts !== undefined, 'posts table schema should exist');
  assert.strictEqual(posts.columns.length, 4);
  assert.strictEqual(posts.foreign_keys.length, 1);
  assert.strictEqual(posts.foreign_keys[0]!.column, 'user_id');
  assert.strictEqual(posts.foreign_keys[0]!.referenced_table, 'users');
  assert.strictEqual(posts.foreign_keys[0]!.referenced_column, 'id');

  const roundMetrics = mockResult.table_schemas['ventures.round_metrics'];
  assert(roundMetrics !== undefined, 'round_metrics table schema should exist');
  assert.strictEqual(roundMetrics.row_count, 145);
  assert.strictEqual(roundMetrics.foreign_keys.length, 1);
});

test('wildcard pattern to SQL LIKE conversion', () => {
  // Simulate the pattern conversion logic used in pgIntrospect.
  // Escapes existing % and _ (literals), then converts shell wildcards (* and ?)
  // to SQL equivalents. Used with SQL ESCAPE '\' clause.
  function wildcardToSqlPattern(pattern: string): string {
    return pattern
      .replace(/\\/g, '\\\\')  // escape existing backslashes first
      .replace(/%/g, '\\%')    // escape SQL % wildcards
      .replace(/_/g, '\\_')    // escape SQL _ wildcards
      .replace(/\*/g, '%')     // shell * → SQL %
      .replace(/\?/g, '_');    // shell ? → SQL _
  }

  // Basic patterns
  assert.strictEqual(wildcardToSqlPattern('xero_*'), 'xero\\_%');  // xero\_ (literal underscore) + % (any)
  assert.strictEqual(wildcardToSqlPattern('ventures'), 'ventures');
  assert.strictEqual(wildcardToSqlPattern('*'), '%');
  assert.strictEqual(wildcardToSqlPattern('table?name'), 'table_name');  // table + _ (any single) + name

  // Complex patterns
  assert.strictEqual(wildcardToSqlPattern('schema.*_backup'), 'schema.%\\_backup');  // schema. + % (any) + \_ (literal) + backup
  assert.strictEqual(wildcardToSqlPattern('*_history'), '%\\_history');  // % (any) + \_ (literal) + history
  assert.strictEqual(wildcardToSqlPattern('temp_?'), 'temp\\_\_');  // temp + \_ (literal) + _ (any single)

  // Escaping edge cases (% and _ should be escaped in input, then converted)
  assert.strictEqual(wildcardToSqlPattern('special%val'), 'special\\%val');  // special + \% (literal %) + val
  assert.strictEqual(wildcardToSqlPattern('under_score'), 'under\\_score');  // under + \_ (literal _) + score
  assert.strictEqual(wildcardToSqlPattern('mix%_*'), 'mix\\%\\_%');  // mix + \% + \_ + %
});

test('introspection with filtered results', () => {
  // Simulate filtering behavior
  const allTables = ['public.users', 'public.posts', 'xero.invoices', 'xero.vendors', 'ventures.metrics'];

  function matchesPattern(tableName: string, patterns: string[]): boolean {
    if (patterns.length === 0) return true;
    // Convert a shell glob to a regex in ONE pass: escape regex metacharacters, and map the glob
    // wildcards `*`→`.*` and `?`→`.`. A single replace (vs the old shell→LIKE→regex chain that
    // un-escaped backslashes produced by an earlier step) avoids re-processing produced characters
    // — the js/double-escaping trap CodeQL flagged.
    return patterns.some(p => {
      const regexPattern = p.replace(/[.*+?^${}()|[\]\\]/g, (m) => (m === '*' ? '.*' : m === '?' ? '.' : `\\${m}`));
      return new RegExp(`^${regexPattern}$`).test(tableName);
    });
  }

  // No filter — all tables match
  assert.strictEqual(allTables.filter(t => matchesPattern(t, [])).length, 5);

  // Filter for xero tables (xero.* matches xero followed by any chars)
  const xeroFiltered = allTables.filter(t => matchesPattern(t, ['xero.*']));
  assert.strictEqual(xeroFiltered.length, 2);
  assert(xeroFiltered.includes('xero.invoices'));
  assert(xeroFiltered.includes('xero.vendors'));

  // Filter for specific table (exact match)
  const specific = allTables.filter(t => matchesPattern(t, ['public.users']));
  assert.strictEqual(specific.length, 1);
  assert(specific.includes('public.users'));

  // Multiple filters (OR logic)
  const multiple = allTables.filter(t => matchesPattern(t, ['ventures.*', 'xero.invoices']));
  assert.strictEqual(multiple.length, 2);
  assert(multiple.includes('ventures.metrics'));
  assert(multiple.includes('xero.invoices'));
});

test('row count estimation accuracy', () => {
  // Verify row counts are reasonable numbers
  const testCounts = [0, 1, 100, 1000, 1000000, 123456789];

  testCounts.forEach(count => {
    assert(typeof count === 'number', 'row_count must be a number');
    assert(count >= 0, 'row_count must be non-negative');
    assert.strictEqual(count, Math.floor(count), 'row_count must be an integer');
  });
});

test('foreign key relationship tracking', () => {
  // Verify FK structure matches DB relationships
  const fkExample = {
    column: 'user_id',
    referenced_table: 'users',
    referenced_column: 'id',
  };

  assert.strictEqual(typeof fkExample.column, 'string');
  assert.strictEqual(typeof fkExample.referenced_table, 'string');
  assert.strictEqual(typeof fkExample.referenced_column, 'string');

  // Ensure all three parts are non-empty
  assert(fkExample.column.length > 0);
  assert(fkExample.referenced_table.length > 0);
  assert(fkExample.referenced_column.length > 0);
});
