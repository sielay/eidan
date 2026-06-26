// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Db } from "./db.js";
import { AgentsStore } from "./store.js";

if (!process.env.DATABASE_URL) {
  console.log("⊘ DATABASE_URL not set; skipping agents response-trigger tests");
} else {
  describe("Agents response trigger", () => {
    let db: Db;
    let store: AgentsStore;
    const testUserId = "00000000-0000-0000-0000-000000000003";

    before(async () => {
      db = new Db(process.env.DATABASE_URL!);
      store = new AgentsStore(db);
    });

    after(async () => {
      await db.close();
    });

    it("creates and lists response-triggered agents", async () => {
      // Create an agent with a response trigger
      const agent = await store.createAgent({
        name: "ResponseAgent",
        persona: "You are a responsive agent that acts on feedback.",
        provider: "claude",
      });
      assert.ok(agent?.id);

      const trigger = await store.addTrigger(agent.id, "response", {});
      assert.strictEqual(trigger.type, "response");
      assert.deepStrictEqual(trigger.config, {});
      assert.ok(trigger.enabled);

      // Verify responseTriggeredAgents includes this agent
      const agents = await store.responseTriggeredAgents();
      const found = agents.find((a) => a.agent_id === agent.id);
      assert.ok(found);
      assert.strictEqual(found?.name, "ResponseAgent");
    });

    it("tracks multiple response-triggered agents", async () => {
      const agent1 = await store.createAgent({
        name: "Reviewer1",
        persona: "First reviewer",
      });
      const agent2 = await store.createAgent({
        name: "Reviewer2",
        persona: "Second reviewer",
      });

      await store.addTrigger(agent1.id, "response", {});
      await store.addTrigger(agent2.id, "response", {});

      const agents = await store.responseTriggeredAgents();
      const ids = agents.map((a) => a.agent_id);
      assert.ok(ids.includes(agent1.id));
      assert.ok(ids.includes(agent2.id));
    });

    it("excludes disabled response triggers", async () => {
      const agent = await store.createAgent({
        name: "DisabledAgent",
        persona: "This agent will be disabled.",
      });

      const trigger = await store.addTrigger(agent.id, "response", {});

      // Disable the trigger
      await db.query(
        `update eidan.agent_triggers set enabled = false where id = $1`,
        [trigger.id]
      );

      const agents = await store.responseTriggeredAgents();
      const found = agents.find((a) => a.agent_id === agent.id);
      assert.strictEqual(found, undefined);
    });

    it("includes target_node in response-triggered agent info", async () => {
      const agent = await store.createAgent({
        name: "NodePinnedAgent",
        persona: "Pinned to a specific node.",
        target_node: "kesha",
      });

      await store.addTrigger(agent.id, "response", {});

      const agents = await store.responseTriggeredAgents();
      const found = agents.find((a) => a.agent_id === agent.id);
      assert.strictEqual(found?.target_node, "kesha");
    });
  });
}
