import { afterEach, describe, expect, it, vi } from "vitest";

// Mock @/lib/auth.authFetch so the API-client functions can be
// tested without a real auth state. Each test stubs the response
// the mock returns.
vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
}));

import { authFetch } from "@/lib/auth";
import { getKnowledgeRow, listKnowledge } from "./knowledge";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.mocked(authFetch).mockReset();
});

describe("listKnowledge", () => {
  it("hits /api/knowledge with no query params by default", async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(
      jsonResponse({ knowledge: [] }),
    );
    await listKnowledge();
    expect(authFetch).toHaveBeenCalledWith(
      "/api/knowledge",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("appends skill + limit query params when supplied", async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(
      jsonResponse({ knowledge: [] }),
    );
    await listKnowledge({ skill: "coding", limit: 25 });
    const calls = vi.mocked(authFetch).mock.calls;
    expect(calls[0][0]).toBe("/api/knowledge?skill=coding&limit=25");
  });

  it("returns the rows from the backend envelope", async () => {
    const row = {
      id: "11111111-1111-1111-1111-111111111111",
      slug: "x",
      title: "Test",
      skill: "coding",
      updated_at: "2026-05-19T00:00:00Z",
      created_at: "2026-05-18T00:00:00Z",
    };
    vi.mocked(authFetch).mockResolvedValueOnce(
      jsonResponse({ knowledge: [row] }),
    );
    const out = await listKnowledge();
    expect(out).toEqual([row]);
  });

  it("throws on a non-200 response", async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(jsonResponse({}, 500));
    await expect(listKnowledge()).rejects.toThrow(/returned 500/);
  });
});

describe("getKnowledgeRow", () => {
  it("hits /api/knowledge/<id>", async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(
      jsonResponse({
        knowledge: {
          id: "abc",
          slug: null,
          title: "x",
          skill: null,
          body: "hello",
          source: null,
          updated_at: "2026-05-19T00:00:00Z",
          created_at: "2026-05-18T00:00:00Z",
        },
      }),
    );
    await getKnowledgeRow("abc");
    expect(authFetch).toHaveBeenCalledWith(
      "/api/knowledge/abc",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("throws on a 404", async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(
      jsonResponse({ error: "not found" }, 404),
    );
    await expect(getKnowledgeRow("abc")).rejects.toThrow(/returned 404/);
  });

  it("returns the inner knowledge envelope verbatim", async () => {
    const row = {
      id: "abc",
      slug: "test",
      title: "T",
      skill: "coding",
      body: "body text",
      source: "agent",
      updated_at: "2026-05-19T00:00:00Z",
      created_at: "2026-05-18T00:00:00Z",
    };
    vi.mocked(authFetch).mockResolvedValueOnce(
      jsonResponse({ knowledge: row }),
    );
    const out = await getKnowledgeRow("abc");
    expect(out).toEqual(row);
  });
});
