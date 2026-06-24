// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import SocialConnections from "@/plugins/_shared/SocialConnections";

export default function Connections(): React.ReactElement {
  return (
    <SocialConnections
      name="social-bluesky"
      title="Bluesky"
      flavor="app_password"
      blurb="Connect one or more Bluesky accounts so the agent can post and read on your behalf. You provide your handle and an app password (not your login password); the app password is sealed in your vault — never shown back or handed to a model."
      setupHelp={
        <>
          In Bluesky, go to <strong>Settings &rarr; App Passwords</strong> (
          bsky.app/settings/app-passwords) and create an app password. Then paste your handle (e.g.
          <strong> you.bsky.social</strong>) and that app password here. Leave the service URL blank
          unless you run a custom AT Protocol PDS.
        </>
      }
    />
  );
}
