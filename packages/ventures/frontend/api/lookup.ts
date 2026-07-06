// SPDX-License-Identifier: AGPL-3.0-or-later
// POST /api/charles/ventures/lookup — UK Companies House lookup (the ⚡ hybrid action behind the
// venture identity panel). Mirrors the `venture_lookup_company` agent tool, but as a deterministic
// UI route. Self-contained (no import from the plugin's src/, which isn't copied into apps/web):
// validate the number → fetch CH (key as basic-auth user) → map the flat profile → optionally fold
// it into the venture's metadata.identity. Owner-scoped.
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";
import { withUser } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CH_API_BASE = "https://api.company-information.service.gov.uk";
const CH_NUMBER_RE = /^(SC|NI|OC|SO|NC|R|FC|GE|GS|GN|GI|AC|SA)?[0-9]{6,8}$/;
const CH_KEY_ENV = "EIDAN_COMPANIES_HOUSE_KEY";
const PROFILE_FIELDS = ["company_number", "company_name", "company_status", "type", "date_of_creation", "jurisdiction"];

function normalise(number: string): string | null {
  const cleaned = number.replace(/\s+/g, "").toUpperCase();
  return cleaned && CH_NUMBER_RE.test(cleaned) ? cleaned : null;
}

function addressLine(raw: Record<string, unknown>): string | null {
  const addr = (raw["registered_office_address"] as Record<string, unknown>) ?? {};
  const parts = ["address_line_1", "address_line_2", "locality", "postal_code", "country"]
    .map((k) => addr[k])
    .filter((p): p is string => typeof p === "string" && p.length > 0);
  return parts.length ? parts.join(", ") : null;
}

function toProfile(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PROFILE_FIELDS) out[k] = raw[k] ?? null;
  out["registered_office"] = addressLine(raw);
  out["sic_codes"] = raw["sic_codes"] ?? [];
  out["source"] = "companies_house";
  return out;
}

export async function POST(req: NextRequest): Promise<Response> {
  const sess = verifyBearer(req);
  if (!sess) return new Response("unauthorized", { status: 401 });

  const apiKey = process.env[CH_KEY_ENV];
  if (!apiKey) {
    return Response.json({ error: `Companies House lookup is not configured (set ${CH_KEY_ENV})` }, { status: 501 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const number = normalise(typeof body["registration_number"] === "string" ? body["registration_number"] : "");
  if (!number) {
    return Response.json({ error: "that doesn’t look like a UK Companies House number (8 digits, or SC/NI/OC + 6 digits)" }, { status: 400 });
  }
  const ventureId = typeof body["venture_id"] === "string" ? body["venture_id"].trim() : "";

  // Fetch the official record (key as basic-auth username, blank password).
  let raw: Record<string, unknown>;
  try {
    const auth = Buffer.from(`${apiKey}:`).toString("base64");
    const resp = await fetch(`${CH_API_BASE}/company/${number}`, {
      headers: { authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (resp.status === 401) return Response.json({ error: "Companies House rejected the API key" }, { status: 502 });
    if (resp.status === 404) return Response.json({ error: `no company found for ${number}` }, { status: 404 });
    if (resp.status !== 200) return Response.json({ error: `Companies House returned HTTP ${resp.status}` }, { status: 502 });
    raw = (await resp.json()) as Record<string, unknown>;
  } catch (err) {
    return Response.json({ error: `Companies House request failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 });
  }
  if (!raw || typeof raw !== "object" || !raw["company_number"]) {
    return Response.json({ error: `unexpected Companies House response for ${number}` }, { status: 502 });
  }
  const identity = toProfile(raw);

  let linked = false;
  if (ventureId) {
    const ok = await withUser(sess.userId, async (c) => {
      const r = await c.query(
        `update plugin_ventures.ventures
            set metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{identity}', $3::jsonb, true),
                updated_at = now()
          where id = $2 and user_id = $1 and status = 'active'`,
        [sess.userId, ventureId, JSON.stringify(identity)],
      );
      return (r.rowCount ?? 0) > 0;
    });
    if (!ok) return Response.json({ error: "no such venture to link the identity to" }, { status: 404 });
    linked = true;
  }

  return Response.json({ identity, linked });
}
