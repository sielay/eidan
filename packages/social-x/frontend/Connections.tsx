// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import SocialConnections from "@/plugins/_shared/SocialConnections";

export default function Connections(): React.ReactElement {
  return (
    <SocialConnections
      name="social-x"
      title="X (Twitter)"
      flavor="oauth2_pkce"
      defaultScopes="tweet.read tweet.write users.read offline.access"
      blurb="Connect one or more X accounts so the agent can post and read on your behalf. You provide your own X OAuth app (client ID + secret); both, and the resulting access/refresh tokens, are sealed in your vault — never shown back or handed to a model."
      setupHelp={
        <>
          In the X developer portal (developer.twitter.com), create an OAuth&nbsp;2.0 app with{" "}
          <strong>Read and Write</strong> permissions, enable <strong>PKCE</strong>, and register the
          redirect URI below. Then paste the client ID and secret here.
        </>
      }
    />
  );
}
