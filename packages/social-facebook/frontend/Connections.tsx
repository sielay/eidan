// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import SocialConnections from "@/plugins/_shared/SocialConnections";

export default function Connections(): React.ReactElement {
  return (
    <SocialConnections
      name="social-facebook"
      title="Facebook"
      flavor="oauth2"
      defaultScopes="pages_manage_posts pages_read_engagement public_profile"
      blurb="Connect one or more Facebook accounts so the agent can post and read on your behalf. You provide your own Facebook OAuth app (client ID + secret); both, and the resulting access token, are sealed in your vault — never shown back or handed to a model."
      setupHelp={
        <>
          In the Meta for Developers portal (developers.facebook.com), create an app, add the{" "}
          <strong>Facebook Login</strong> product, and register the redirect URI below as a valid OAuth
          redirect URI. Then paste the client ID (App ID) and secret (App Secret) here.
        </>
      }
    />
  );
}
