// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import SocialConnections from "@/plugins/_shared/SocialConnections";

export default function Connections(): React.ReactElement {
  return (
    <SocialConnections
      name="social-tiktok"
      title="TikTok"
      flavor="oauth2"
      defaultScopes="user.info.basic,user.info.profile,user.info.stats,video.list,video.publish"
      blurb="Connect one or more TikTok accounts so the agent can read your profile + videos and publish videos on your behalf. You provide your own TikTok Login Kit client (client key + secret); both, and the resulting access/refresh tokens, are sealed in your vault — never shown back or handed to a model."
      setupHelp={
        <>
          In the <strong>TikTok for Developers</strong> console, add the <strong>Login Kit</strong>,{" "}
          <strong>Display API</strong> and <strong>Content Posting API</strong> products, register the
          redirect URI below, then paste the app&rsquo;s <strong>client key</strong> and{" "}
          <strong>client secret</strong> here. New apps run in sandbox — add your TikTok account as a
          target user to test.
        </>
      }
    />
  );
}
