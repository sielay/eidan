// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/auth/config — public, unauthenticated. The login screen reads this to know the sign-in
// method. The operator's allowed email is NOT exposed (verify re-checks it server-side).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ provider: "magic-link", providers: ["magic-link"], tos_url: null, privacy_url: null });
}
