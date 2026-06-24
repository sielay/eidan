// SPDX-License-Identifier: AGPL-3.0-or-later
// /api/social-instagram/accounts — thin wrapper over the shared social accounts route (vendored into
// apps/web at deploy). All logic lives in @/plugins/_shared/socialAccountsRoute.
import { makeSocialAccountsRoute } from "@/plugins/_shared/socialAccountsRoute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const h = makeSocialAccountsRoute({
  name: "social-instagram",
  provider: "instagram",
  schema: "plugin_social_instagram",
  flavor: "oauth2",
});

export const GET = h.GET;
export const POST = h.POST;
export const PUT = h.PUT;
export const DELETE = h.DELETE;
