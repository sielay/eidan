// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import SocialConnections from "@/plugins/_shared/SocialConnections";

export default function Connections(): React.ReactElement {
  return (
    <SocialConnections
      name="social-linkedin"
      title="LinkedIn"
      flavor="oauth2"
      defaultScopes="openid profile email w_member_social"
      connTypes={[
        { value: "member", label: "Profile (member)", scopes: "openid profile email w_member_social" },
        {
          value: "organization",
          label: "Page / Organization",
          scopes:
            "r_basicprofile rw_organization_admin r_organization_social w_organization_social w_member_social r_organization_followers",
          needsTarget: true,
          targetLabel: "LinkedIn Page",
          targetHelp:
            "Which Page this connection is for — its numeric Organization ID, vanity name, or full company URL (e.g. 1234567, acme, or https://www.linkedin.com/company/acme). Add one connection per Page you manage.",
        },
      ]}
      blurb="Connect one or more LinkedIn accounts so the agent can post and read on your behalf. You provide your own LinkedIn OAuth app (client ID + secret); both, and the resulting access token, are sealed in your vault — never shown back or handed to a model."
      setupHelp={
        <>
          LinkedIn gates scopes by the app’s <strong>Products</strong>, and the{" "}
          <strong>Community Management API</strong> product can’t be combined with{" "}
          <strong>Sign In with LinkedIn (OpenID)</strong> / <strong>Share on LinkedIn</strong> — so use a
          separate app per kind. <strong>Profile (member)</strong>: an app with Sign-In + Share, scopes{" "}
          <code>openid profile email w_member_social</code>. <strong>Page / Organization</strong>: an app
          with the <strong>Community Management API</strong> product, scopes{" "}
          <code>r_basicprofile rw_organization_admin r_organization_social w_organization_social w_member_social r_organization_followers</code>{" "}
          (page management is included via <code>rw_organization_admin</code> — no extra product needed).
          The App-kind picker prefills these; register the redirect URI below in each app.
        </>
      }
    />
  );
}
