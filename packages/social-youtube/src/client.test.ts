// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import * as assert from 'node:assert';
import { YouTubeClient } from './client.js';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';

const mockFetch = (responses: Map<string, any>) => {
  (global as any).fetch = async (url: string) => {
    for (const [pattern, response] of responses.entries()) {
      if (url.includes(pattern)) {
        return {
          ok: true,
          status: 200,
          json: async () => response,
          text: async () => JSON.stringify(response),
        };
      }
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ error: 'Not found' }),
      text: async () => 'Not found',
    };
  };
};

test('YouTubeClient.create: succeeds with valid token', async () => {
  const mockCtx = {
    vault: {
      resolve: async () => 'valid-token',
    },
  } as any;

  const result = await YouTubeClient.create(mockCtx);
  assert.ok(!('error' in result));
});

test('YouTubeClient.create: returns error when token is missing', async () => {
  const mockCtx = {
    vault: {
      resolve: async () => {
        throw new MissingSecretError('YOUTUBE_ACCESS_TOKEN');
      },
    },
  } as any;

  const result = await YouTubeClient.create(mockCtx);
  assert.ok('error' in result);
  assert.match(result.error, /YouTube not connected/);
});

test('YouTubeClient.search: returns videos', async () => {
  const responses = new Map([
    [
      '/search',
      {
        kind: 'youtube#searchListResponse',
        etag: 'test',
        items: [
          {
            kind: 'youtube#searchResult',
            etag: 'item',
            id: { kind: 'youtube#video', videoId: 'vid123' },
            snippet: {
              publishedAt: '2023-01-01T00:00:00Z',
              title: 'Test Video',
              description: 'Test desc',
              thumbnails: { default: { url: 'https://example.com/thumb.jpg' } },
              channelId: 'ch123',
              channelTitle: 'Test Channel',
              liveBroadcastContent: 'none',
            },
          },
        ],
      },
    ],
  ]);
  mockFetch(responses);

  const mockCtx = { vault: {} } as any;
  const client = new YouTubeClient(mockCtx, 'test-token');
  const result = await client.search('test query', 10);

  assert.ok(!result.error);
  assert.strictEqual(result.videos.length, 1);
  assert.strictEqual(result.videos[0]?.videoId, 'vid123');
  assert.strictEqual(result.videos[0]?.title, 'Test Video');
});

test('YouTubeClient.getChannel: returns channel info', async () => {
  const responses = new Map([
    [
      '/channels',
      {
        kind: 'youtube#channelListResponse',
        etag: 'test',
        pageInfo: { totalResults: 1, resultsPerPage: 1 },
        items: [
          {
            kind: 'youtube#channel',
            etag: 'ch',
            id: 'UCtest',
            snippet: {
              title: 'My Channel',
              description: 'Channel description',
              publishedAt: '2020-01-01T00:00:00Z',
              thumbnails: { default: { url: 'https://example.com/ch.jpg' } },
            },
            statistics: {
              viewCount: '1000000',
              commentCount: '500',
              subscriberCount: '50000',
              hiddenSubscriberCount: false,
              videoCount: '100',
            },
          },
        ],
      },
    ],
  ]);
  mockFetch(responses);

  const mockCtx = { vault: {} } as any;
  const client = new YouTubeClient(mockCtx, 'test-token');
  const result = await client.getChannel();

  assert.ok(!result.error);
  assert.strictEqual(result.channel?.title, 'My Channel');
  assert.strictEqual(result.channel?.subscribers, '50000');
  assert.strictEqual(result.channel?.views, '1000000');
});

test('YouTubeClient.listVideos: returns user videos', async () => {
  const responses = new Map([
    [
      '/search',
      {
        kind: 'youtube#searchListResponse',
        etag: 'test',
        pageInfo: { totalResults: 2, resultsPerPage: 2 },
        items: [
          {
            kind: 'youtube#searchResult',
            etag: 'v1',
            id: { kind: 'youtube#video', videoId: 'myVid1' },
            snippet: {
              publishedAt: '2023-06-20T00:00:00Z',
              title: 'Video 1',
              description: 'First video',
              thumbnails: { default: { url: 'https://example.com/v1.jpg' } },
              channelId: 'UCmine',
              channelTitle: 'My Channel',
              liveBroadcastContent: 'none',
            },
          },
          {
            kind: 'youtube#searchResult',
            etag: 'v2',
            id: { kind: 'youtube#video', videoId: 'myVid2' },
            snippet: {
              publishedAt: '2023-06-10T00:00:00Z',
              title: 'Video 2',
              description: 'Second video',
              thumbnails: { default: { url: 'https://example.com/v2.jpg' } },
              channelId: 'UCmine',
              channelTitle: 'My Channel',
              liveBroadcastContent: 'none',
            },
          },
        ],
      },
    ],
  ]);
  mockFetch(responses);

  const mockCtx = { vault: {} } as any;
  const client = new YouTubeClient(mockCtx, 'test-token');
  const result = await client.listVideos(10);

  assert.ok(!result.error);
  assert.strictEqual(result.videos.length, 2);
  assert.strictEqual(result.videos[0]?.videoId, 'myVid1');
});

test('YouTubeClient.postComment: returns comment ID', async () => {
  const responses = new Map([
    [
      '/commentThreads',
      {
        kind: 'youtube#comment',
        etag: 'cmt',
        id: 'comment-xyz-123',
        snippet: {
          videoId: 'vid123',
          textDisplay: 'Great video!',
          textOriginal: 'Great video!',
          parentId: 'vid123',
          authorDisplayName: 'Test User',
          authorProfileImageUrl: 'https://example.com/av.jpg',
          authorChannelUrl: 'https://youtube.com/channel/UCtest',
          authorChannelId: { value: 'UCtest' },
          canReply: true,
          canDelete: true,
          canLike: true,
          likeCount: 0,
          publishedAt: '2023-01-01T00:00:00Z',
          updatedAt: '2023-01-01T00:00:00Z',
        },
      },
    ],
  ]);
  mockFetch(responses);

  const mockCtx = { vault: {} } as any;
  const client = new YouTubeClient(mockCtx, 'test-token');
  const result = await client.postComment('vid123', 'Great video!');

  assert.ok(!result.error);
  assert.strictEqual(result.commentId, 'comment-xyz-123');
});
