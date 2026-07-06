// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Q } from './db.js';
import {
  slugify,
  createVenture,
  getVenture,
  listVentures,
  getSubtree,
  reparent,
  updateVenture,
  attachResource,
  listResources,
  detachResource,
  setVentureIdentity,
  setVenturePlan,
  addItem,
  listItems,
  setItemStatus,
} from './store.js';

// ─── Mock query function for testing store logic without a real database ──────
function makeMockQuery(response?: { rows: unknown[]; rowCount: number }): { q: Q; setResponse: (r: unknown) => void } {
  let mockResponse = response || { rows: [], rowCount: 0 };
  const q: Q = async (sql: string, params: unknown[] = []) => {
    return mockResponse;
  };
  return {
    q,
    setResponse: (r: unknown) => {
      mockResponse = r as { rows: unknown[]; rowCount: number };
    },
  };
}

describe('slugify', () => {
  it('converts to lowercase and replaces spaces with hyphens', () => {
    assert.equal(slugify('My Cool Venture'), 'my-cool-venture');
  });

  it('strips leading/trailing whitespace', () => {
    assert.equal(slugify('  venture  '), 'venture');
  });

  it('handles multiple consecutive special characters', () => {
    assert.equal(slugify('Hello... World!!!'), 'hello-world');
  });

  it('removes leading and trailing hyphens', () => {
    assert.equal(slugify('---venture---'), 'venture');
  });

  it('returns default "venture" for empty input', () => {
    assert.equal(slugify(''), 'venture');
    assert.equal(slugify('   '), 'venture');
  });

  it('truncates to 60 characters', () => {
    const long = 'a'.repeat(70);
    assert.equal(slugify(long), 'a'.repeat(60));
  });

  it('keeps numbers and hyphens', () => {
    assert.equal(slugify('project-2024-v1'), 'project-2024-v1');
  });
});

describe('createVenture', () => {
  it('returns a venture row when successful', async () => {
    const mockResult = {
      rows: [{
        id: 'v1',
        user_id: 'user1',
        parent_id: null,
        name: 'My Venture',
        slug: 'my-venture',
        kind: 'venture',
        legal_type: null,
        status: 'active',
        metadata: {},
        created_at: new Date(),
        updated_at: new Date(),
      }],
      rowCount: 1,
    };
    const { q, setResponse } = makeMockQuery();
    setResponse(mockResult);

    const result = await createVenture(q, {
      userId: 'user1',
      name: 'My Venture',
    });

    assert.equal(result?.name, 'My Venture');
    assert.equal(result?.slug, 'my-venture');
    assert.equal(result?.status, 'active');
  });

  it('returns null when insert returns no rows', async () => {
    const { q } = makeMockQuery();
    const result = await createVenture(q, {
      userId: 'user1',
      name: 'Venture',
    });
    assert.equal(result, null);
  });

  it('generates slug from name when not provided', async () => {
    const mockResult = {
      rows: [{
        id: 'v1',
        user_id: 'user1',
        parent_id: null,
        name: 'Hello World',
        slug: 'hello-world',
        kind: 'venture',
        legal_type: null,
        status: 'active',
        metadata: {},
        created_at: new Date(),
        updated_at: new Date(),
      }],
      rowCount: 1,
    };
    const { q, setResponse } = makeMockQuery();
    setResponse(mockResult);

    const result = await createVenture(q, {
      userId: 'user1',
      name: 'Hello World',
    });

    assert.equal(result?.slug, 'hello-world');
  });

  it('defaults kind to "venture" when not provided', async () => {
    const mockResult = {
      rows: [{
        id: 'v1',
        user_id: 'user1',
        parent_id: null,
        name: 'Test',
        slug: 'test',
        kind: 'venture',
        legal_type: null,
        status: 'active',
        metadata: {},
        created_at: new Date(),
        updated_at: new Date(),
      }],
      rowCount: 1,
    };
    const { q, setResponse } = makeMockQuery();
    setResponse(mockResult);

    const result = await createVenture(q, { userId: 'user1', name: 'Test' });
    assert.equal(result?.kind, 'venture');
  });
});

describe('getVenture', () => {
  it('returns the venture when found', async () => {
    const venture = {
      id: 'v1',
      user_id: 'user1',
      parent_id: null,
      name: 'Test',
      slug: 'test',
      kind: 'venture',
      legal_type: null,
      status: 'active',
      metadata: {},
      created_at: new Date(),
      updated_at: new Date(),
    };
    const { q, setResponse } = makeMockQuery();
    setResponse({ rows: [venture], rowCount: 1 });

    const result = await getVenture(q, 'user1', 'v1');
    assert.equal(result?.id, 'v1');
    assert.equal(result?.name, 'Test');
  });

  it('returns null when venture not found', async () => {
    const { q } = makeMockQuery();
    const result = await getVenture(q, 'user1', 'v1');
    assert.equal(result, null);
  });
});

describe('listVentures', () => {
  it('returns array of venture rows', async () => {
    const ventures = [
      { id: 'v1', name: 'First', user_id: 'u1' },
      { id: 'v2', name: 'Second', user_id: 'u1' },
    ];
    const { q, setResponse } = makeMockQuery();
    setResponse({ rows: ventures, rowCount: 2 });

    const result = await listVentures(q, 'u1');
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 'v1');
    assert.equal(result[1].id, 'v2');
  });

  it('returns empty array when no ventures found', async () => {
    const { q } = makeMockQuery();
    const result = await listVentures(q, 'u1');
    assert.equal(result.length, 0);
  });
});

describe('getSubtree', () => {
  it('returns venture and descendants', async () => {
    const rows = [
      { id: 'root', parent_id: null, name: 'Root', user_id: 'u1', depth: 0 },
      { id: 'child1', parent_id: 'root', name: 'Child 1', user_id: 'u1', depth: 1 },
      { id: 'child2', parent_id: 'root', name: 'Child 2', user_id: 'u1', depth: 1 },
    ];
    const { q, setResponse } = makeMockQuery();
    setResponse({ rows, rowCount: 3 });

    const result = await getSubtree(q, 'u1', 'root');
    assert.equal(result.length, 3);
    assert.equal(result[0].id, 'root');
  });

  it('returns empty array when root not found', async () => {
    const { q } = makeMockQuery();
    const result = await getSubtree(q, 'u1', 'nonexistent');
    assert.equal(result.length, 0);
  });
});

describe('reparent', () => {
  it('throws error if venture parented to itself', async () => {
    const { q } = makeMockQuery();
    try {
      await reparent(q, 'u1', 'v1', 'v1');
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok((err as Error).message.includes('cannot be its own parent'));
    }
  });

  it('allows null newParentId for top-level reparenting', async () => {
    const { q, setResponse } = makeMockQuery();
    setResponse({ rows: [], rowCount: 1 });

    const result = await reparent(q, 'u1', 'v1', null);
    assert.equal(result, true);
  });

  it('returns true when row was updated', async () => {
    const { q, setResponse } = makeMockQuery();
    setResponse({ rows: [], rowCount: 1 });

    const result = await reparent(q, 'u1', 'v1', 'v2');
    assert.equal(result, true);
  });

  it('returns false when no row matched', async () => {
    const { q, setResponse } = makeMockQuery();
    setResponse({ rows: [], rowCount: 0 });

    const result = await reparent(q, 'u1', 'v1', 'v2');
    assert.equal(result, false);
  });
});

describe('updateVenture', () => {
  it('throws error if name is blank', async () => {
    const { q } = makeMockQuery();
    try {
      await updateVenture(q, 'u1', 'v1', { name: '  ' });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok((err as Error).message.includes('blank'));
    }
  });

  it('returns the updated venture when successful', async () => {
    const updated = { id: 'v1', name: 'Updated', slug: 'updated', user_id: 'u1' };
    const { q, setResponse } = makeMockQuery();
    setResponse({ rows: [updated], rowCount: 1 });

    const result = await updateVenture(q, 'u1', 'v1', { name: 'Updated' });
    assert.equal(result?.name, 'Updated');
    assert.equal(result?.slug, 'updated');
  });

  it('returns null when no venture matched', async () => {
    const { q } = makeMockQuery();
    const result = await updateVenture(q, 'u1', 'v1', { name: 'New' });
    assert.equal(result, null);
  });

  it('handles legalType updates', async () => {
    const updated = { id: 'v1', legal_type: 'llc', user_id: 'u1' };
    const { q, setResponse } = makeMockQuery();
    setResponse({ rows: [updated], rowCount: 1 });

    const result = await updateVenture(q, 'u1', 'v1', { legalType: 'llc' });
    assert.equal(result?.legal_type, 'llc');
  });

  it('handles status updates', async () => {
    const updated = { id: 'v1', status: 'archived', user_id: 'u1' };
    const { q, setResponse } = makeMockQuery();
    setResponse({ rows: [updated], rowCount: 1 });

    const result = await updateVenture(q, 'u1', 'v1', { status: 'archived' });
    assert.equal(result?.status, 'archived');
  });
});

describe('attachResource', () => {
  it('returns a resource row when successful', async () => {
    const resource = { id: 'r1', venture_id: 'v1', kind: 'social_account', provider: 'manual', user_id: 'u1' };
    const { q, setResponse } = makeMockQuery();
    setResponse({ rows: [resource], rowCount: 1 });

    const result = await attachResource(q, {
      userId: 'u1',
      ventureId: 'v1',
      kind: 'social_account',
      provider: 'manual',
      externalRef: '@handle',
    });

    assert.equal(result?.id, 'r1');
    assert.equal(result?.provider, 'manual');
  });

  it('returns null when insert returns no rows', async () => {
    const { q } = makeMockQuery();
    const result = await attachResource(q, {
      userId: 'u1',
      ventureId: 'v1',
      kind: 'social_account',
      provider: 'manual',
      externalRef: '@handle',
    });
    assert.equal(result, null);
  });
});

describe('listResources', () => {
  it('returns array of resource rows', async () => {
    const resources = [
      { id: 'r1', venture_id: 'v1', user_id: 'u1' },
      { id: 'r2', venture_id: 'v1', user_id: 'u1' },
    ];
    const { q, setResponse } = makeMockQuery();
    setResponse({ rows: resources, rowCount: 2 });

    const result = await listResources(q, 'u1');
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 'r1');
  });

  it('returns empty array when no resources found', async () => {
    const { q } = makeMockQuery();
    const result = await listResources(q, 'u1');
    assert.equal(result.length, 0);
  });

  it('supports filtering by ventureId', async () => {
    const resources = [{ id: 'r1', venture_id: 'v1', user_id: 'u1' }];
    const { q, setResponse } = makeMockQuery();
    setResponse({ rows: resources, rowCount: 1 });

    const result = await listResources(q, 'u1', 'v1');
    assert.equal(result.length, 1);
  });
});

describe('detachResource', () => {
  it('returns true when a row was updated', async () => {
    const { q, setResponse } = makeMockQuery();
    setResponse({ rows: [], rowCount: 1 });

    const result = await detachResource(q, 'u1', 'r1');
    assert.equal(result, true);
  });

  it('returns false when no row matched', async () => {
    const { q, setResponse } = makeMockQuery();
    setResponse({ rows: [], rowCount: 0 });

    const result = await detachResource(q, 'u1', 'r1');
    assert.equal(result, false);
  });
});

describe('setVentureIdentity', () => {
  it('merges identity into metadata when successful', async () => {
    const updated = {
      id: 'v1',
      metadata: { identity: { ch_number: '12345' } },
      user_id: 'u1',
    };
    const { q, setResponse } = makeMockQuery();
    setResponse({ rows: [updated], rowCount: 1 });

    const result = await setVentureIdentity(q, 'u1', 'v1', { ch_number: '12345' });

    assert.equal(result?.id, 'v1');
    assert.equal(result?.metadata.identity?.ch_number, '12345');
  });

  it('returns null when no venture matched', async () => {
    const { q } = makeMockQuery();
    const result = await setVentureIdentity(q, 'u1', 'v1', {});
    assert.equal(result, null);
  });
});

describe('setVenturePlan', () => {
  it('merges plan into metadata when successful', async () => {
    const plan = { goal: 'build product', status: 'active' };
    const updated = { id: 'v1', metadata: { plan }, user_id: 'u1' };
    const { q, setResponse } = makeMockQuery();
    setResponse({ rows: [updated], rowCount: 1 });

    const result = await setVenturePlan(q, 'u1', 'v1', plan);

    assert.equal(result?.metadata.plan?.goal, 'build product');
  });

  it('returns null when no venture matched', async () => {
    const { q } = makeMockQuery();
    const result = await setVenturePlan(q, 'u1', 'v1', {});
    assert.equal(result, null);
  });
});

describe('addItem', () => {
  it('returns an item row when successful', async () => {
    const item = { id: 'i1', venture_id: 'v1', title: 'Task 1', kind: 'task', user_id: 'u1' };
    const { q, setResponse } = makeMockQuery();
    setResponse({ rows: [item], rowCount: 1 });

    const result = await addItem(q, {
      userId: 'u1',
      ventureId: 'v1',
      title: 'Task 1',
    });

    assert.equal(result?.id, 'i1');
    assert.equal(result?.kind, 'task');
  });

  it('returns null when venture does not exist', async () => {
    const { q } = makeMockQuery();
    const result = await addItem(q, {
      userId: 'u1',
      ventureId: 'v1',
      title: 'Task',
    });

    assert.equal(result, null);
  });

  it('defaults kind to "task"', async () => {
    const item = { id: 'i1', venture_id: 'v1', title: 'Task', kind: 'task', user_id: 'u1' };
    const { q, setResponse } = makeMockQuery();
    setResponse({ rows: [item], rowCount: 1 });

    const result = await addItem(q, {
      userId: 'u1',
      ventureId: 'v1',
      title: 'Task',
    });

    assert.equal(result?.kind, 'task');
  });
});

describe('listItems', () => {
  it('returns array of item rows', async () => {
    const items = [
      { id: 'i1', venture_id: 'v1', user_id: 'u1' },
      { id: 'i2', venture_id: 'v1', user_id: 'u1' },
    ];
    const { q, setResponse } = makeMockQuery();
    setResponse({ rows: items, rowCount: 2 });

    const result = await listItems(q, 'u1', 'v1');
    assert.equal(result.length, 2);
  });

  it('returns empty array when no items found', async () => {
    const { q } = makeMockQuery();
    const result = await listItems(q, 'u1', 'v1');
    assert.equal(result.length, 0);
  });

  it('supports filtering archived items', async () => {
    const items = [
      { id: 'i1', status: 'open' },
      { id: 'i2', status: 'archived' },
    ];
    const { q, setResponse } = makeMockQuery();
    setResponse({ rows: [items[0]], rowCount: 1 });

    const result = await listItems(q, 'u1', 'v1', false);
    assert.equal(result.length, 1);
  });
});

describe('setItemStatus', () => {
  it('returns the updated item when successful', async () => {
    const updated = { id: 'i1', status: 'done', user_id: 'u1' };
    const { q, setResponse } = makeMockQuery();
    setResponse({ rows: [updated], rowCount: 1 });

    const result = await setItemStatus(q, 'u1', 'i1', 'done');

    assert.equal(result?.status, 'done');
  });

  it('returns null when no item matched', async () => {
    const { q } = makeMockQuery();
    const result = await setItemStatus(q, 'u1', 'i1', 'done');

    assert.equal(result, null);
  });
});
