// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import * as assert from 'node:assert';
import type {
  YouTubeSearchResult,
  ChannelResponse,
  VideoListResponse,
  CommentInsertResponse,
} from './types.js';

test('types: YouTubeSearchResult structure', () => {
  const result: YouTubeSearchResult = {
    kind: 'youtube#searchListResponse',
    etag: 'test-etag',
    items: [
      {
        kind: 'youtube#searchResult',
        etag: 'item-etag',
        id: {
          kind: 'youtube#video',
          videoId: 'dQw4w9WgXcQ',
        },
        snippet: {
          publishedAt: '2023-01-01T00:00:00Z',
          title: 'Test Video',
          description: 'Test description',
          thumbnails: {
            default: { url: 'https://example.com/thumb.jpg' },
          },
          channelId: 'UCtest123',
          channelTitle: 'Test Channel',
          liveBroadcastContent: 'none',
        },
      },
    ],
  };

  assert.strictEqual(result.kind, 'youtube#searchListResponse');
  assert.strictEqual(result.items?.[0]?.snippet.title, 'Test Video');
});

test('types: ChannelResponse structure', () => {
  const channel: ChannelResponse = {
    kind: 'youtube#channelListResponse',
    etag: 'test-etag',
    pageInfo: { totalResults: 1, resultsPerPage: 1 },
    items: [
      {
        kind: 'youtube#channel',
        etag: 'channel-etag',
        id: 'UCtest123',
        snippet: {
          title: 'Test Channel',
          description: 'Test channel description',
          publishedAt: '2020-01-01T00:00:00Z',
          thumbnails: {
            default: { url: 'https://example.com/channel.jpg' },
          },
        },
        statistics: {
          viewCount: '1000000',
          commentCount: '500',
          subscriberCount: '5000',
          hiddenSubscriberCount: false,
          videoCount: '100',
        },
      },
    ],
  };

  assert.strictEqual(channel.items?.[0]?.statistics.viewCount, '1000000');
});

test('types: CommentInsertResponse structure', () => {
  const comment: CommentInsertResponse = {
    kind: 'youtube#comment',
    etag: 'comment-etag',
    id: 'comment-id-123',
    snippet: {
      videoId: 'dQw4w9WgXcQ',
      textDisplay: 'Great video!',
      textOriginal: 'Great video!',
      parentId: 'dQw4w9WgXcQ',
      authorDisplayName: 'Test User',
      authorProfileImageUrl: 'https://example.com/avatar.jpg',
      authorChannelUrl: 'https://youtube.com/channel/UCtest',
      authorChannelId: { value: 'UCtest' },
      canReply: true,
      canDelete: true,
      canLike: true,
      likeCount: 0,
      publishedAt: '2023-01-01T00:00:00Z',
      updatedAt: '2023-01-01T00:00:00Z',
    },
  };

  assert.strictEqual(comment.snippet.textDisplay, 'Great video!');
  assert.strictEqual(comment.id, 'comment-id-123');
});
