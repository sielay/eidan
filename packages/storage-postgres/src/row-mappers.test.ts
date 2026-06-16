// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rowToMessage, rowToSession, type ConvRow, type MsgRow } from './row-mappers.js';

const at = (s: string): Date => new Date(s);
const msgRow = (o: Partial<MsgRow>): MsgRow => ({
  id: 'm', role: 'assistant', content_blocks: [], provider: null, trace_id: null,
  metadata: {}, created_at: at('2026-06-16T10:00:00Z'), ...o,
} as MsgRow);
const convRow = (o: Partial<ConvRow>): ConvRow => ({
  id: 'c1', user_id: 'u1', title: null, status: 'active', persona: null, contexts: null,
  parent_conversation_id: null, origin_message_id: null, version: '3',
  created_at: at('2026-06-16T10:00:00Z'), updated_at: at('2026-06-16T11:00:00Z'), ...o,
} as ConvRow);

describe('rowToMessage', () => {
  it('round-trips content_blocks, ISO-formats the date, defaults traceId, omits absent optionals', () => {
    const blocks = [{ type: 'text', text: 'hi' }] as MsgRow['content_blocks'];
    const m = rowToMessage(msgRow({ id: 'm1', role: 'assistant', content_blocks: blocks }));
    assert.equal(m.id, 'm1');
    assert.equal(m.role, 'assistant');
    assert.deepEqual(m.content, blocks);
    assert.equal(m.createdAt, '2026-06-16T10:00:00.000Z');
    assert.equal(m.traceId, '');
    assert.ok(!('providerName' in m));
    assert.ok(!('metadata' in m));
  });

  it('includes provider + non-empty metadata when present', () => {
    const m = rowToMessage(msgRow({ provider: 'claude', trace_id: 't1', metadata: { k: 1 } }));
    assert.equal(m.providerName, 'claude');
    assert.equal(m.traceId, 't1');
    assert.deepEqual(m.metadata, { k: 1 });
  });
});

describe('rowToSession', () => {
  it('maps core fields, stringifies version, defaults contexts, omits absent optionals', () => {
    const s = rowToSession(convRow({}), []);
    assert.equal(s.id, 'c1');
    assert.equal(s.version, '3');
    assert.equal(s.ownerPrincipalId, 'u1');
    assert.equal(s.status, 'active');
    assert.deepEqual(s.contexts, []);
    assert.deepEqual(s.messages, []);
    assert.equal(s.createdAt, '2026-06-16T10:00:00.000Z');
    assert.equal(s.updatedAt, '2026-06-16T11:00:00.000Z');
    assert.ok(!('title' in s));
    assert.ok(!('parentSessionId' in s));
  });

  it('includes optionals when present and carries messages through', () => {
    const s = rowToSession(
      convRow({ title: 'T', persona: 'p', parent_conversation_id: 'p1', origin_message_id: 'o1', contexts: ['x'] }),
      [rowToMessage(msgRow({ id: 'm9' }))],
    );
    assert.equal(s.title, 'T');
    assert.equal(s.persona, 'p');
    assert.equal(s.parentSessionId, 'p1');
    assert.equal(s.branchPointMessageId, 'o1');
    assert.deepEqual(s.contexts, ['x']);
    assert.equal(s.messages.length, 1);
    assert.equal(s.messages[0]?.id, 'm9');
  });
});
