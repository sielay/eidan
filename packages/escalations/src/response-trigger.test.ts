// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Db } from "./db.js";
import { EscalationsStore, type RaiseArgs, type RespondArgs } from "./store.js";

if (!process.env.DATABASE_URL) {
  console.log("⊘ DATABASE_URL not set; skipping escalations response-trigger tests");
} else {
  describe("Escalations response trigger emission", () => {
    let db: Db;
    let store: EscalationsStore;
    const testUserId = "00000000-0000-0000-0000-000000000002";

    before(async () => {
      db = new Db(process.env.DATABASE_URL!);
      store = new EscalationsStore(db);
    });

    after(async () => {
      await db.close();
    });

    it("fetches escalation with trigger_prompt after respond", async () => {
      const escalationArgs: RaiseArgs = {
        severity: "medium",
        reasonClass: "ambiguous_intent",
        suggestedAction: "Need clarification",
        fromAgent: "Detective",
        toAgent: "Analyzer",
        escalationType: "agent_to_agent",
        triggerPrompt: "The data suggests a different interpretation. Please reconsider.",
        userId: testUserId,
      };

      const escalation = await store.insert(escalationArgs);
      assert.ok(escalation !== null);
      assert.ok(escalation?.id);

      const respondArgs: RespondArgs = {
        id: escalation!.id,
        feedback: "Here's the clarification you need",
        userId: testUserId,
      };

      const response = await store.respond(respondArgs);
      assert.ok(response !== null);

      // Verify we can fetch the escalation with its trigger_prompt
      const fetched = await store.getEscalation(escalation!.id);
      assert.ok(fetched !== null);
      assert.strictEqual(fetched?.to_agent, "Analyzer");
      assert.strictEqual(fetched?.trigger_prompt, "The data suggests a different interpretation. Please reconsider.");
      assert.strictEqual(fetched?.status, "responded");
      assert.ok(fetched?.response?.feedback?.includes("clarification"));
    });

    it("emits with null trigger_prompt falls back to feedback", async () => {
      const escalationArgs: RaiseArgs = {
        severity: "low",
        reasonClass: "other",
        suggestedAction: "Check status",
        fromAgent: "Monitor",
        toAgent: "Worker",
        escalationType: "agent_to_agent",
        // No triggerPrompt set
        userId: testUserId,
      };

      const escalation = await store.insert(escalationArgs);
      assert.ok(escalation !== null);

      const respondArgs: RespondArgs = {
        id: escalation!.id,
        feedback: "Status is all clear",
        userId: testUserId,
      };

      const response = await store.respond(respondArgs);
      assert.ok(response !== null);

      const fetched = await store.getEscalation(escalation!.id);
      assert.ok(fetched !== null);
      assert.strictEqual(fetched?.trigger_prompt, null);
      assert.strictEqual(fetched?.response?.feedback, "Status is all clear");
    });
  });
}
