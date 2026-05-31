// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
}));

import { authFetch } from "@/lib/auth";
import {
  fetchConversation,
  regenerateConversationTitle,
  updateConversationTitle,
} from "./conversations";

/**
 * Unit tests for the conversation-title API client functions (issue
 * #48). The wire shapes are pinned in the backend's
 * ``ConversationUpdate.schema.json`` and the matching route handlers
 * in ``apps/backend/eidan_backend/http/routes.py``.
 */

const mockedAuthFetch = authFetch as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  mockedAuthFetch.mockReset();
});

describe("updateConversationTitle", () => {
  it("PATCHes the conversation with the new title and returns the parsed body", async () => {
    mockedAuthFetch.mockResolvedValueOnce(
      jsonResponse({ id: "conv-1", title: "Renamed" }),
    );

    const result = await updateConversationTitle("conv-1", "Renamed");

    expect(mockedAuthFetch).toHaveBeenCalledWith(
      "/api/conversations/conv-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ title: "Renamed" }),
      }),
    );
    expect(result).toEqual({ id: "conv-1", title: "Renamed" });
  });

  it("serialises null titles as a literal null on the wire", async () => {
    mockedAuthFetch.mockResolvedValueOnce(
      jsonResponse({ id: "conv-1", title: null }),
    );

    await updateConversationTitle("conv-1", null);

    expect(mockedAuthFetch).toHaveBeenCalledWith(
      "/api/conversations/conv-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ title: null }),
      }),
    );
  });

  it("throws when the backend rejects the PATCH", async () => {
    mockedAuthFetch.mockResolvedValueOnce(
      new Response("not found", { status: 404 }),
    );

    await expect(updateConversationTitle("conv-1", "x")).rejects.toThrow(
      /returned 404/,
    );
  });
});

describe("regenerateConversationTitle", () => {
  it("POSTs to the regenerate route and returns the new title", async () => {
    mockedAuthFetch.mockResolvedValueOnce(
      jsonResponse({ id: "conv-1", title: "Auto Title" }),
    );

    const result = await regenerateConversationTitle("conv-1");

    expect(mockedAuthFetch).toHaveBeenCalledWith(
      "/api/conversations/conv-1/regenerate_title",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result).toEqual({ id: "conv-1", title: "Auto Title" });
  });

  it("throws on a non-2xx response", async () => {
    mockedAuthFetch.mockResolvedValueOnce(
      new Response("upstream failed", { status: 502 }),
    );

    await expect(regenerateConversationTitle("conv-1")).rejects.toThrow(
      /returned 502/,
    );
  });
});

describe("fetchConversation", () => {
  it("GETs the single-conversation route and returns the row", async () => {
    mockedAuthFetch.mockResolvedValueOnce(
      jsonResponse({
        id: "conv-1",
        title: "Hi",
        created_at: "2026-05-31T00:00:00Z",
        updated_at: "2026-05-31T00:00:01Z",
      }),
    );

    const row = await fetchConversation("conv-1");
    expect(mockedAuthFetch).toHaveBeenCalledWith(
      "/api/conversations/conv-1",
      expect.objectContaining({ method: "GET" }),
    );
    expect(row.title).toBe("Hi");
  });
});
