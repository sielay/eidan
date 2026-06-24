// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import SocialConnections from "@/plugins/_shared/SocialConnections";

export default function Connections(): React.ReactElement {
  return (
    <SocialConnections
      name="social-youtube"
      title="YouTube"
      flavor="oauth2"
      defaultScopes="https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl openid email"
      blurb="Connect one or more YouTube accounts so the agent can comment and read on your behalf. You provide your own Google OAuth client (client ID + secret); both, and the resulting access/refresh tokens, are sealed in your vault — never shown back or handed to a model."
      setupHelp={
        <>
          In the Google&nbsp;Cloud Console, enable the <strong>YouTube Data API v3</strong>, create an{" "}
          <strong>OAuth 2.0 Web application</strong> client, and register the redirect URI below. Then
          paste the client ID and secret here.
        </>
      }
    />
  );
}
