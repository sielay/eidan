// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LinkedInProfile, LinkedInPost, LinkedInProfileResponse } from './types.js';

test('LinkedInProfile type validates basic profile', () => {
  const profile: LinkedInProfile = {
    id: '123456',
    localizedFirstName: 'John',
    localizedLastName: 'Doe',
    localizedHeadline: 'Software Engineer',
  };

  assert.equal(profile.id, '123456');
  assert.equal(profile.localizedFirstName, 'John');
});

test('LinkedInPost type validates post structure', () => {
  const post: LinkedInPost = {
    id: 'post123',
    actor: 'urn:li:person:123456',
    created: Date.now(),
    likesSummary: {
      totalLikes: 42,
    },
    commentsSummary: {
      totalFirstLevelComments: 5,
    },
  };

  assert.equal(post.id, 'post123');
  assert.equal(post.likesSummary?.totalLikes, 42);
});

test('LinkedInProfileResponse type validates extended profile', () => {
  const response: LinkedInProfileResponse = {
    id: '123456',
    localizedFirstName: 'Jane',
    localizedLastName: 'Smith',
    localizedHeadline: 'Product Manager',
    firstName: {
      localized: {
        en_US: 'Jane',
      },
    },
  };

  assert.equal(response.id, '123456');
  assert.equal(response.localizedFirstName, 'Jane');
});
