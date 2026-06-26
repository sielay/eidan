// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { Db } from "./db.js";
import { EscalationsStore, type RaiseArgs, type RespondArgs } from "./store.js";

describe("Escalations v2", () => {
  let db: Db;
  let store: EscalationsStore;
  const testUserId = "00000000-0000-0000-0000-000000000001";

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL must be set");
    db = new Db(url);
    store = new EscalationsStore(db);
  });

  afterAll(async () => {
    await db.close();
  });

  describe("agent_to_agent escalation", () => {
    it("raises an escalation from one agent to another", async () => {
      const args: RaiseArgs = {
        severity: "high",
        reasonClass: "ambiguous_intent",
        suggestedAction: "Need clarification on intent",
        fromAgent: "Researcher",
        toAgent: "Analyzer",
        escalationType: "agent_to_agent",
        triggerPrompt: "Review the research and clarify next steps",
        userId: testUserId,
      };

      const result = await store.insert(args);
      expect(result).not.toBeNull();
      expect(result?.id).toBeDefined();

      const rows = await store.list({
        userId: testUserId,
        toAgent: "Analyzer",
        status: "open",
      });
      expect(rows.length).toBeGreaterThan(0);
      const row = rows[0];
      expect(row.from_agent).toBe("Researcher");
      expect(row.to_agent).toBe("Analyzer");
      expect(row.escalation_type).toBe("agent_to_agent");
      expect(row.status).toBe("open");
    });

    it("allows an agent to respond to an escalation", async () => {
      const escalation = await store.insert({
        severity: "medium",
        reasonClass: "missing_input",
        suggestedAction: "Need more data",
        fromAgent: "Worker1",
        toAgent: "Worker2",
        escalationType: "agent_to_agent",
        userId: testUserId,
      });

      expect(escalation).not.toBeNull();

      const respondArgs: RespondArgs = {
        id: escalation!.id,
        feedback: "I've processed the data with available inputs",
        decision: "proceed_with_partial",
        tags: ["partial-data", "acknowledged"],
        userId: testUserId,
      };

      const response = await store.respond(respondArgs);
      expect(response).not.toBeNull();

      const rows = await store.list({
        userId: testUserId,
        toAgent: "Worker2",
        status: "responded",
      });
      expect(rows.length).toBeGreaterThan(0);
      const row = rows[0];
      expect(row.response?.feedback).toContain("processed");
      expect(row.response?.decision).toBe("proceed_with_partial");
    });

    it("allows first agent to query for responses", async () => {
      const escalation = await store.insert({
        severity: "low",
        reasonClass: "other",
        suggestedAction: "Check something",
        fromAgent: "AgentA",
        toAgent: "AgentB",
        escalationType: "agent_to_agent",
        userId: testUserId,
      });

      expect(escalation).not.toBeNull();

      // AgentB responds
      await store.respond({
        id: escalation!.id,
        feedback: "Done, result is X",
        userId: testUserId,
      });

      // AgentA queries for responses
      const responses = await store.list({
        userId: testUserId,
        fromAgent: "AgentA",
        status: "responded",
      });
      expect(responses.length).toBeGreaterThan(0);
      expect(responses[0].response?.feedback).toBe("Done, result is X");
    });
  });

  describe("operator_to_agent escalation", () => {
    it("operator can send feedback to an agent", async () => {
      const escalation = await store.insert({
        severity: "high",
        reasonClass: "permission_denied",
        suggestedAction: "Need authorization",
        fromAgent: "DataAgent",
        escalationType: "operator_to_agent",
        userId: testUserId,
      });

      expect(escalation).not.toBeNull();

      const response = await store.respond({
        id: escalation!.id,
        feedback: "Authorization granted for DataAPI v2",
        decision: "grant_access",
        reasoning: "User has cleared compliance review",
        tags: ["compliance", "api-access"],
        userId: testUserId,
      });

      expect(response).not.toBeNull();

      const rows = await store.list({
        userId: testUserId,
        status: "responded",
      });

      const responded = rows.find((r) => r.id === escalation!.id);
      expect(responded).toBeDefined();
      expect(responded?.response?.feedback).toContain("Authorization");
      expect(responded?.response?.tags).toContain("compliance");
    });
  });

  describe("backwards compatibility", () => {
    it("old escalations still work (agent_to_operator default)", async () => {
      const args: RaiseArgs = {
        severity: "medium",
        reasonClass: "over_budget",
        suggestedAction: "Approve extra budget",
        userId: testUserId,
      };

      const result = await store.insert(args);
      expect(result).not.toBeNull();

      const rows = await store.list({
        userId: testUserId,
        status: "pending",
      });
      const row = rows.find((r) => r.id === result!.id);
      expect(row?.escalation_type).toBe("agent_to_operator");
      expect(row?.status).toBe("pending");
    });
  });
});
