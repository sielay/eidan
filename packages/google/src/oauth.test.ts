// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildAuthUrl, GMAIL_SCOPES, GOOGLE_AUTH_URL } from "./oauth.js";

describe("buildAuthUrl", () => {
  it("builds a consent URL that forces a refresh token and round-trips state", () => {
    const url = buildAuthUrl({
      clientId: "cid.apps.googleusercontent.com",
      redirectUri: "https://app.example/p/google/callback",
      state: "acct-123",
    });
    assert.equal(url.startsWith(`${GOOGLE_AUTH_URL}?`), true);
    const params = new URL(url).searchParams;
    assert.equal(params.get("client_id"), "cid.apps.googleusercontent.com");
    assert.equal(params.get("redirect_uri"), "https://app.example/p/google/callback");
    assert.equal(params.get("response_type"), "code");
    // access_type=offline + prompt=consent are what make Google return a refresh_token.
    assert.equal(params.get("access_type"), "offline");
    assert.equal(params.get("prompt"), "consent");
    assert.equal(params.get("state"), "acct-123");
    assert.equal(params.get("scope"), GMAIL_SCOPES.join(" "));
  });

  it("honours a custom scope list", () => {
    const url = buildAuthUrl({
      clientId: "cid",
      redirectUri: "https://app.example/p/google/callback",
      state: "s",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    });
    assert.equal(
      new URL(url).searchParams.get("scope"),
      "https://www.googleapis.com/auth/gmail.readonly",
    );
  });
});
