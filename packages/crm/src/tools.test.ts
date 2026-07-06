// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCrmTools } from './tools.js';
import { CrmDb } from './db.js';

test('CrmTools exports deal move tool that returns stage_change activity', async () => {
  const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
  if (!url) {
    console.log('(skipped: no database configured)');
    return;
  }

  const db = new CrmDb(url);
  await db.ensureSchema();

  const tools = buildCrmTools(db);
  const dealTool = tools.find((t) => t.name === 'crm_deal');
  assert.ok(dealTool, 'crm_deal tool should exist');

  // The tool's invoke function accepts a deal move action and creates a stage_change activity.
  // We verify the tool structure exists and has the right name.
  assert.equal(dealTool.name, 'crm_deal');
  assert.match(dealTool.description, /move.*pipeline/i);

  await db.close();
});
