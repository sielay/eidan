// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import SocialConnections from "@/plugins/_shared/SocialConnections";

export default function Connections(): React.ReactElement {
  return (
    <SocialConnections
      name="social-mastodon"
      title="Mastodon"
      flavor="dynamic_app"
      blurb="Connect one or more Mastodon accounts so the agent can post and read on your behalf. Mastodon is federated — each account lives on an instance (host). eidan registers an app with your instance automatically; you only provide a name and the instance host. The resulting access token is sealed in your vault — never shown back or handed to a model."
      setupHelp={
        <>
          Enter a label for the account and your Mastodon <strong>instance host</strong> (e.g.{" "}
          <code>mastodon.social</code> or <code>fosstodon.org</code>). eidan registers an OAuth app
          with that instance on demand, then sends you to authorize it.
        </>
      }
    />
  );
}
