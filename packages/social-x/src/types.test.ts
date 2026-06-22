// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'assert';
import type { XUserProfile, XTweet, XUserResponse, XTweetsResponse } from './types.js';

export async function testTypeStructures() {
  const userProfile: XUserProfile = {
    id: '12345',
    name: 'Test User',
    username: 'testuser',
    created_at: '2023-01-01T00:00:00Z',
    description: 'A test user',
    followers_count: 100,
    following_count: 50,
    tweet_count: 10,
    verified: false,
  };

  assert.strictEqual(userProfile.id, '12345');
  assert.strictEqual(userProfile.name, 'Test User');
  assert.strictEqual(userProfile.username, 'testuser');
  assert.strictEqual(userProfile.followers_count, 100);

  const tweet: XTweet = {
    id: '67890',
    text: 'Hello, X!',
    author_id: '12345',
    created_at: '2024-01-01T00:00:00Z',
    public_metrics: {
      retweet_count: 5,
      reply_count: 2,
      like_count: 20,
      quote_count: 1,
    },
  };

  assert.strictEqual(tweet.id, '67890');
  assert.strictEqual(tweet.text, 'Hello, X!');
  assert.strictEqual(tweet.public_metrics?.like_count, 20);

  const userResponse: XUserResponse = {
    data: userProfile,
  };

  assert.strictEqual(userResponse.data?.name, 'Test User');

  const tweetsResponse: XTweetsResponse = {
    data: [tweet],
    meta: {
      result_count: 1,
      newest_id: '67890',
    },
  };

  assert.strictEqual(tweetsResponse.data?.[0]?.text, 'Hello, X!');
  assert.strictEqual(tweetsResponse.meta?.result_count, 1);
}
