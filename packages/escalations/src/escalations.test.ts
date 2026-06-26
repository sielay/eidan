// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Db } from "./db.js";
import { EscalationsStore, type RaiseArgs, type RespondArgs } from "./store.js";

if (!process.env.DATABASE_URL) {
  console.log("⊘ DATABASE_URL not set; skipping escalations tests");
} else {
  describe("Escalations v2", () => {
    let db: Db;
    let store: EscalationsStore;
    const testUserId = "00000000-0000-0000-0000-000000000001";

    before(async () => {
      db = new Db(process.env.DATABASE_URL!);
      store = new EscalationsStore(db);
    });

    after(async () => {
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
        assert.ok(result !== null);
        assert.ok(result?.id !== undefined);

        const rows = await store.list({
          userId: testUserId,
          toAgent: "Analyzer",
          status: "open",
        });
        assert.ok(rows.length > 0);
        const row = rows[0];
        assert.strictEqual(row.from_agent, "Researcher");
        assert.strictEqual(row.to_agent, "Analyzer");
        assert.strictEqual(row.escalation_type, "agent_to_agent");
        assert.strictEqual(row.status, "open");
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

        assert.ok(escalation !== null);

        const respondArgs: RespondArgs = {
          id: escalation!.id,
          feedback: "I've processed the data with available inputs",
          decision: "proceed_with_partial",
          tags: ["partial-data", "acknowledged"],
          userId: testUserId,
        };

        const response = await store.respond(respondArgs);
        assert.ok(response !== null);

        const rows = await store.list({
          userId: testUserId,
          toAgent: "Worker2",
          status: "responded",
        });
        assert.ok(rows.length > 0);
        const row = rows[0];
        assert.ok(row.response?.feedback?.includes("processed"));
        assert.strictEqual(row.response?.decision, "proceed_with_partial");
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

        assert.ok(escalation !== null);

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
        assert.ok(responses.length > 0);
        assert.strictEqual(responses[0].response?.feedback, "Done, result is X");
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

        assert.ok(escalation !== null);

        const response = await store.respond({
          id: escalation!.id,
          feedback: "Authorization granted for DataAPI v2",
          decision: "grant_access",
          reasoning: "User has cleared compliance review",
          tags: ["compliance", "api-access"],
          userId: testUserId,
        });

        assert.ok(response !== null);

        const rows = await store.list({
          userId: testUserId,
          status: "responded",
        });

        const responded = rows.find((r) => r.id === escalation!.id);
        assert.ok(responded !== undefined);
        assert.ok(responded?.response?.feedback?.includes("Authorization"));
        assert.ok(responded?.response?.tags?.includes("compliance"));
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
        assert.ok(result !== null);

        const rows = await store.list({
          userId: testUserId,
          status: "pending",
        });
        const row = rows.find((r) => r.id === result!.id);
        assert.strictEqual(row?.escalation_type, "agent_to_operator");
        assert.strictEqual(row?.status, "pending");
      });
    });
  });
}
