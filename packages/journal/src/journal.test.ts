// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { normalizeEntryType, isRoutableRepo, codeJobTarget, DEFAULT_DIRECTION_PROMPT } from './types.js';
import { captureAndRoute } from './routing.js';
import type { JournalDb, CaptureInput } from './db.js';
import type { JournalEntry } from './types.js';

describe('normalizeEntryType', () => {
  it('passes through known types', () => {
    for (const t of ['devlog', 'bug', 'idea', 'content_seed', 'task']) {
      assert.strictEqual(normalizeEntryType(t), t);
    }
  });
  it('is case- and separator-insensitive', () => {
    assert.strictEqual(normalizeEntryType('BUG'), 'bug');
    assert.strictEqual(normalizeEntryType('content-seed'), 'content_seed');
    assert.strictEqual(normalizeEntryType(' content seed '), 'content_seed');
  });
  it('maps common synonyms', () => {
    assert.strictEqual(normalizeEntryType('fix'), 'bug');
    assert.strictEqual(normalizeEntryType('todo'), 'task');
    assert.strictEqual(normalizeEntryType('update'), 'devlog');
    assert.strictEqual(normalizeEntryType('post'), 'content_seed');
  });
  it('falls back to devlog for unknown / non-string', () => {
    assert.strictEqual(normalizeEntryType('whatever'), 'devlog');
    assert.strictEqual(normalizeEntryType(null), 'devlog');
    assert.strictEqual(normalizeEntryType(42), 'devlog');
    assert.strictEqual(normalizeEntryType(''), 'devlog');
  });
});

describe('isRoutableRepo', () => {
  it('accepts owner/name', () => {
    assert.ok(isRoutableRepo('sielay/eidan'));
    assert.ok(isRoutableRepo('acme/my-repo.js'));
  });
  it('rejects garbage', () => {
    assert.ok(!isRoutableRepo('not a repo'));
    assert.ok(!isRoutableRepo('sielay'));
    assert.ok(!isRoutableRepo('a/b/c'));
    assert.ok(!isRoutableRepo(''));
    assert.ok(!isRoutableRepo(null));
    assert.ok(!isRoutableRepo(123));
  });
});

describe('codeJobTarget', () => {
  it('routes bug/task with a valid repo', () => {
    assert.strictEqual(codeJobTarget('bug', 'sielay/eidan'), 'sielay/eidan');
    assert.strictEqual(codeJobTarget('task', ' sielay/mathgame '), 'sielay/mathgame');
  });
  it('does not route non-actionable types even with a repo', () => {
    assert.strictEqual(codeJobTarget('devlog', 'sielay/eidan'), null);
    assert.strictEqual(codeJobTarget('idea', 'sielay/eidan'), null);
    assert.strictEqual(codeJobTarget('content_seed', 'sielay/eidan'), null);
  });
  it('does not route bug/task without a valid repo', () => {
    assert.strictEqual(codeJobTarget('bug', null), null);
    assert.strictEqual(codeJobTarget('bug', 'garbage'), null);
    assert.strictEqual(codeJobTarget('task', ''), null);
  });
});

describe('DEFAULT_DIRECTION_PROMPT', () => {
  it('mentions every entry type so the model has the taxonomy', () => {
    for (const t of ['devlog', 'bug', 'idea', 'content_seed', 'task']) {
      assert.ok(DEFAULT_DIRECTION_PROMPT.includes(t), `prompt should mention ${t}`);
    }
  });
});

// ── captureAndRoute over a fake db (no Postgres) ───────────────────────────────
const UUID = '834fcecc-0000-4000-8000-000000000000';

function fakeEntry(input: CaptureInput, id = 'entry-1'): JournalEntry {
  return {
    id,
    user_id: UUID,
    project: input.project,
    entry_type: input.entry_type,
    summary: input.summary,
    body: input.body,
    source: input.source,
    target_repo: input.target_repo,
    metadata: {},
    job_id: null,
    created_at: new Date(0),
    updated_at: new Date(0),
  };
}

interface FakeCalls {
  inserted: CaptureInput[];
  enqueued: Array<{ userId: string | null; requestedBy: string | null; goal: string; payload: Record<string, unknown> }>;
  stamped: Array<{ entryId: string; jobId: string }>;
}

function makeFakeDb(jobId: string | null): { db: JournalDb; calls: FakeCalls } {
  const calls: FakeCalls = { inserted: [], enqueued: [], stamped: [] };
  const db = {
    async insertEntry(input: CaptureInput) { calls.inserted.push(input); return fakeEntry(input); },
    async enqueueCodeJob(userId: string | null, requestedBy: string | null, goal: string, payload: Record<string, unknown>) {
      calls.enqueued.push({ userId, requestedBy, goal, payload });
      return jobId;
    },
    async stampJob(entryId: string, jobId2: string) { calls.stamped.push({ entryId, jobId: jobId2 }); },
  } as unknown as JournalDb;
  return { db, calls };
}

describe('captureAndRoute', () => {
  it('opens a code job for a bug with a routable repo and stamps it back', async () => {
    const { db, calls } = makeFakeDb('job-99');
    const res = await captureAndRoute(db, UUID, {
      project: 'mathgame', entry_type: 'bug', summary: 'scoring off by one', body: null, source: 'telegram', target_repo: 'sielay/mathgame',
    });
    assert.ok(res);
    assert.strictEqual(res.routed, 'code_job');
    assert.strictEqual(res.job_id, 'job-99');
    assert.strictEqual(res.entry.job_id, 'job-99');
    assert.strictEqual(calls.enqueued.length, 1);
    assert.strictEqual(calls.enqueued[0]?.userId, UUID);
    assert.strictEqual(calls.enqueued[0]?.requestedBy, null);
    assert.strictEqual(calls.enqueued[0]?.payload['repo'], 'sielay/mathgame');
    assert.deepStrictEqual(calls.stamped, [{ entryId: 'entry-1', jobId: 'job-99' }]);
  });

  it('just logs a devlog (no job, no stamp)', async () => {
    const { db, calls } = makeFakeDb('job-99');
    const res = await captureAndRoute(db, UUID, {
      project: 'eidan', entry_type: 'devlog', summary: 'built the journal facility', body: null, source: 'chat', target_repo: null,
    });
    assert.ok(res);
    assert.strictEqual(res.routed, 'logged');
    assert.strictEqual(res.job_id, null);
    assert.strictEqual(calls.enqueued.length, 0);
    assert.strictEqual(calls.stamped.length, 0);
  });

  it('logs (does not delegate) a bug with no routable repo', async () => {
    const { db, calls } = makeFakeDb('job-99');
    const res = await captureAndRoute(db, UUID, {
      project: 'eidan', entry_type: 'bug', summary: 'something is off', body: null, source: null, target_repo: null,
    });
    assert.ok(res);
    assert.strictEqual(res.routed, 'logged');
    assert.strictEqual(calls.enqueued.length, 0);
  });

  it('keeps a non-uuid principal id in requested_by, user_id null', async () => {
    const { db, calls } = makeFakeDb('job-7');
    await captureAndRoute(db, 'telegram-12345', {
      project: 'eidan', entry_type: 'task', summary: 'add X', body: null, source: 'telegram', target_repo: 'sielay/eidan',
    });
    assert.strictEqual(calls.enqueued[0]?.userId, null);
    assert.strictEqual(calls.enqueued[0]?.requestedBy, 'telegram-12345');
  });

  it('reports logged when the enqueue fails to return an id', async () => {
    const { db, calls } = makeFakeDb(null);
    const res = await captureAndRoute(db, UUID, {
      project: 'eidan', entry_type: 'task', summary: 'do thing', body: null, source: null, target_repo: 'sielay/eidan',
    });
    assert.ok(res);
    assert.strictEqual(res.routed, 'logged');
    assert.strictEqual(res.job_id, null);
    assert.strictEqual(calls.enqueued.length, 1);
    assert.strictEqual(calls.stamped.length, 0);
  });
});
