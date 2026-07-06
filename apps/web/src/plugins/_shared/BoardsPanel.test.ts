// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// URL conversion logic extracted and tested inline.
function refToUrl(kind: string, id: string | null, label: string | null): string | null {
  if (!id && !label) return null;
  if (kind === "url") return label || id || null;
  if (kind === "conversation") return id ? `/c/${id}` : null;
  if (kind === "venture") return id ? `/p/ventures/${id}` : null;
  if (kind === "social_account" || kind === "social_post") {
    if (id?.startsWith("at://")) {
      const match = id.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/);
      if (match) return `https://bsky.app/profile/${match[1]}/post/${match[2]}`;
    }
  }
  return null;
}

describe('Card reference URL conversion', () => {
  it('converts Bluesky at:// URI to web URL', () => {
    const uri = "at://did:plc:z72i7hdynmk6r22z27h6tvvrjmQ/app.bsky.feed.post/3la4et2xvs2";
    const result = refToUrl("social_post", uri, null);
    assert.equal(result, "https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvvrjmQ/post/3la4et2xvs2");
  });

  it('handles Bluesky social_account kind', () => {
    const uri = "at://did:plc:abc123/app.bsky.feed.post/xyz789";
    const result = refToUrl("social_account", uri, null);
    assert.equal(result, "https://bsky.app/profile/did:plc:abc123/post/xyz789");
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
