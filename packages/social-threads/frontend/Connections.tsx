// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import SocialConnections from "@/plugins/_shared/SocialConnections";

export default function Connections(): React.ReactElement {
  return (
    <SocialConnections
      name="social-threads"
      title="Threads"
      flavor="oauth2"
      defaultScopes="threads_basic threads_content_publish"
      blurb="Connect one or more Threads accounts so the agent can post and read on your behalf. You provide your own Threads OAuth app (client ID + secret); both, and the resulting access token, are sealed in your vault — never shown back or handed to a model."
      setupHelp={
        <>
          In the Meta developer portal (developers.facebook.com), create a Threads app, enable the{" "}
          <strong>Threads API</strong> use case with <strong>threads_basic</strong> and{" "}
          <strong>threads_content_publish</strong> permissions, and register the redirect URI below.
          Then paste the client ID and secret here.
        </>
      }
    />
  );
}
