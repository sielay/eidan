// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import SocialConnections from "@/plugins/_shared/SocialConnections";

export default function Connections(): React.ReactElement {
  return (
    <SocialConnections
      name="social-instagram"
      title="Instagram"
      flavor="oauth2"
      defaultScopes="instagram_business_basic instagram_business_content_publish"
      blurb="Connect one or more Instagram accounts so the agent can post and read on your behalf. You provide your own Instagram (Meta) OAuth app (client ID + secret); both, and the resulting access token, are sealed in your vault — never shown back or handed to a model."
      setupHelp={
        <>
          In the Meta developer portal (developers.facebook.com), open your app → <strong>Instagram</strong>{" "}
          product → <strong>API setup with Instagram login</strong>. Use the <strong>Instagram app ID</strong>{" "}
          (not the Facebook app ID) + its secret here, add the{" "}
          <strong>instagram_business_basic</strong> and <strong>instagram_business_content_publish</strong>{" "}
          scopes, and register the redirect URI below as an OAuth redirect URI.
        </>
      }
    />
  );
}
