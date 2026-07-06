// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { refToUrl } from './BoardsPanel';


describe('Card reference URL conversion', () => {
  it('converts Bluesky at:// URI to web URL', () => {
    const uri = "at://did:plc:z72i7hdynmk6r22z27h6tvvrjmQ/app.bsky.feed.post/3la4et2xvs2";
    const result = refToUrl("social_post", uri, null);
    assert.equal(result, "https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvvrjmQ/post/3la4et2xvs2");
  });

  it('converts Bluesky DID to social_account profile URL', () => {
    const result = refToUrl("social_account", "did:plc:abc123def456", null);
    assert.equal(result, "https://bsky.app/profile/did:plc:abc123def456");
  });

  it('converts Bluesky handle (without @) to profile URL', () => {
    const result = refToUrl("social_account", "sielay.bsky.social", null);
    assert.equal(result, "https://bsky.app/profile/sielay.bsky.social");
  });

  it('converts Bluesky handle (with @) to profile URL', () => {
    const result = refToUrl("social_account", "@sielay.bsky.social", null);
    assert.equal(result, "https://bsky.app/profile/sielay.bsky.social");
  });

  it('converts Mastodon handle to profile URL', () => {
    const result = refToUrl("social_account", "user@mastodon.social", null);
    assert.equal(result, "https://mastodon.social/@user");
  });

  it('leaves non-at:// social refs as null', () => {
    const result = refToUrl("social_post", "https://example.com", null);
    assert.equal(result, null);
  });

  it('handles URL kind with label', () => {
    const result = refToUrl("url", null, "https://example.com");
    assert.equal(result, "https://example.com");
  });

  it('handles URL kind with id', () => {
    const result = refToUrl("url", "https://example.com", null);
    assert.equal(result, "https://example.com");
  });

  it('converts conversation ref to /c/ path', () => {
    const result = refToUrl("conversation", "conv-123", null);
    assert.equal(result, "/c/conv-123");
  });

  it('converts venture ref to /p/ventures/ path', () => {
    const result = refToUrl("venture", "acme-corp", null);
    assert.equal(result, "/p/ventures/acme-corp");
  });

  it('returns null when no id or label', () => {
    const result = refToUrl("url", null, null);
    assert.equal(result, null);
  });

  it('returns null for unknown kind without id/label', () => {
    const result = refToUrl("job", null, null);
    assert.equal(result, null);
  });
});
