// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert';
import { makeTrading212Tools } from './tools.js';

test('makeTrading212Tools returns array with 3 tools', () => {
  const tools = makeTrading212Tools();
  assert(Array.isArray(tools));
  assert.strictEqual(tools.length, 3);
});

test('tools have correct names', () => {
  const tools = makeTrading212Tools();
  const names = tools.map((t) => t.name).sort();
  assert.deepStrictEqual(names, ['trading212_account', 'trading212_portfolio', 'trading212_trades']);
});
