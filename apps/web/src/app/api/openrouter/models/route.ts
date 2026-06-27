// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/openrouter/models — proxy OpenRouter's public model catalog for the model pickers, slimmed to
// { id, name, prompt, completion, context } and cached. No secret needed (the list is public); the chosen
// model runs via a per-turn synthesized provider profile (see @eidandev/agents + frontend-agui).
import type { NextRequest } from "next/server";

import { verifyBearer } from "@/server/auth";

export const runtime = "nodejs";
export const revalidate = 3600;

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
}

export async function GET(req: NextRequest): Promise<Response> {
  if (!verifyBearer(req)) return new Response("unauthorized", { status: 401 });
  try {
    const r = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Accept: "application/json" },
      next: { revalidate: 3600 },
    });
    if (!r.ok) return Response.json({ models: [], error: `openrouter ${r.status}` });
    const body = (await r.json()) as { data?: OpenRouterModel[] };
    const models = (body.data ?? []).map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      prompt: m.pricing?.prompt ?? null,
      completion: m.pricing?.completion ?? null,
      context: typeof m.context_length === "number" ? m.context_length : null,
    }));
    return Response.json({ models });
  } catch (e) {
    return Response.json({ models: [], error: e instanceof Error ? e.message : String(e) });
  }
}
