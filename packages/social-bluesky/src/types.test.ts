// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  JwtPayload,
  CreateSessionResponse,
  RefreshSessionResponse,
  SessionState,
  FacetIndex,
  Facet,
  BlobRef,
  CreateRecordResponse,
  FeedPost,
  FeedResponse,
  SearchPostsResponse,
  GetPostsResponse,
} from './types.js';

test('types export without error', () => {
  const payload: JwtPayload = { jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjEwMDAwMDAwMDB9.sig' };
  assert.equal(payload.jwt.includes('eyJ'), true);
});

test('CreateSessionResponse type structure', () => {
  const session: CreateSessionResponse = {
    did: 'did:plc:example',
    handle: 'user.bsky.social',
    accessJwt: 'access-jwt-token',
    refreshJwt: 'refresh-jwt-token',
  };
  assert.equal(session.did, 'did:plc:example');
  assert.equal(session.handle, 'user.bsky.social');
});

test('SessionState type structure', () => {
  const state: SessionState = {
    accessJwt: 'token',
    did: 'did:plc:123',
    service: 'https://bsky.social',
  };
  assert.equal(state.service, 'https://bsky.social');
});

test('Facet type structure with link', () => {
  const facet: Facet = {
    index: { byteStart: 0, byteEnd: 10 },
    features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com' }],
  };
  const feature = facet.features[0];
  assert.ok(feature);
  assert.equal(feature.$type, 'app.bsky.richtext.facet#link');
});

test('Facet type structure with tag', () => {
  const facet: Facet = {
    index: { byteStart: 0, byteEnd: 5 },
    features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'example' }],
  };
  const feature = facet.features[0];
  assert.ok(feature);
  assert.equal(feature.$type, 'app.bsky.richtext.facet#tag');
});

test('FeedPost type structure', () => {
  const post: FeedPost = {
    uri: 'at://did:plc:123/app.bsky.feed.post/abc123',
    cid: 'bafy123',
    author: {
      did: 'did:plc:123',
      handle: 'user.bsky.social',
      displayName: 'User Name',
    },
    record: {
      text: 'Hello world',
      createdAt: '2025-01-01T00:00:00Z',
    },
    likeCount: 5,
    replyCount: 2,
    repostCount: 1,
  };
  assert.equal(post.uri.includes('app.bsky.feed.post'), true);
  assert.equal(post.author.handle, 'user.bsky.social');
});

test('FeedResponse type structure', () => {
  const response: FeedResponse = {
    feed: [
      {
        post: {
          uri: 'at://did:plc:123/app.bsky.feed.post/abc123',
          cid: 'bafy123',
          author: {
            did: 'did:plc:123',
            handle: 'user.bsky.social',
          },
          record: {
            text: 'Test',
            createdAt: '2025-01-01T00:00:00Z',
          },
        },
      },
    ],
  };
  const feedItem = response.feed?.[0];
  assert.ok(feedItem);
  assert.ok(feedItem.post.uri.includes('post'));
});
