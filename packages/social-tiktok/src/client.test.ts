// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import * as assert from 'node:assert';
import { TikTokClient } from './client.js';

// Minimal fetch stub keyed by URL substring. Each entry is { ok, status, body }.
const mockFetch = (responses: Map<string, { ok?: boolean; status?: number; body: unknown }>) => {
  (global as unknown as { fetch: unknown }).fetch = async (url: string) => {
    for (const [pattern, r] of responses.entries()) {
      if (url.includes(pattern)) {
        return {
          ok: r.ok ?? true,
          status: r.status ?? 200,
          json: async () => r.body,
          text: async () => JSON.stringify(r.body),
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
  };
};

test('TikTokClient.getProfile: maps the user object', async () => {
  mockFetch(
    new Map([
      [
        '/user/info/',
        { body: { data: { user: { open_id: 'o1', display_name: 'Me', follower_count: 42 } }, error: { code: 'ok' } } },
      ],
    ]),
  );
  const result = await new TikTokClient('t').getProfile();
  assert.ok(!result.error);
  assert.strictEqual(result.user?.open_id, 'o1');
  assert.strictEqual(result.user?.follower_count, 42);
});

test('TikTokClient.getProfile: surfaces an API error code', async () => {
  mockFetch(
    new Map([['/user/info/', { body: { error: { code: 'access_token_invalid', message: 'bad token' } } }]]),
  );
  const result = await new TikTokClient('t').getProfile();
  assert.ok(result.error);
  assert.ok(result.error?.includes('bad token'));
});

test('TikTokClient.listVideos: returns the videos array', async () => {
  mockFetch(
    new Map([
      [
        '/video/list/',
        { body: { data: { videos: [{ id: 'v1', view_count: 10, like_count: 3 }] }, error: { code: 'ok' } } },
      ],
    ]),
  );
  const result = await new TikTokClient('t').listVideos(5);
  assert.ok(!result.error);
  assert.strictEqual(result.videos.length, 1);
  assert.strictEqual(result.videos[0]?.id, 'v1');
});

test('TikTokClient.postVideoFromUrl: returns a publish id', async () => {
  mockFetch(
    new Map([['/post/publish/video/init/', { body: { data: { publish_id: 'pub-123' }, error: { code: 'ok' } } }]]),
  );
  const result = await new TikTokClient('t').postVideoFromUrl({ videoUrl: 'https://ex/v.mp4' });
  assert.ok(!result.error);
  assert.strictEqual(result.publishId, 'pub-123');
});
