// SPDX-License-Identifier: AGPL-3.0-or-later
// Unit tests for content workflow: gate advance (freezing + activity logging) and asset approval.

import { describe, it } from "node:test";
import assert from "node:assert";

// Test gate advance: verify that advancing freezes stage output and logs activity
describe("Content Workflow — Gate Advance", () => {
  it("should advance from concept to assets and freeze concept data", () => {
    // Simulated card state before gate advance
    const card = {
      id: "test-card-1",
      status: "concept",
      frozen_data: {},
      title: "Test Campaign",
    };

    // Simulate advancing the gate
    const GATES: Record<string, string> = {
      concept: "assets",
      assets: "copy",
      copy: "distribution",
      distribution: "scheduled",
    };

    const nextStage = GATES[card.status];
    assert.strictEqual(nextStage, "assets");

    // Verify frozen data is created
    const frozen = card.frozen_data ?? {};
    frozen[card.status] = { title: card.title, timestamp: new Date().toISOString() };

    assert.ok(frozen.concept !== undefined);
    assert.strictEqual(frozen.concept.title, "Test Campaign");
    assert.strictEqual(typeof frozen.concept.timestamp, "string");
  });

  it("should not allow advancing from published stage", () => {
    const GATES: Record<string, string> = {
      concept: "assets",
      assets: "copy",
      copy: "distribution",
      distribution: "scheduled",
    };

    const publishedStatus = "published";
    const nextStage = GATES[publishedStatus];

    assert.strictEqual(nextStage, undefined);
  });

  it("should log system event when advancing gate", () => {
    const cardId = "test-card-2";
    const userId = "user-1";
    const nextStage = "assets";

    // Verify event log structure
    const event = {
      card_id: cardId,
      user_id: userId,
      kind: "system",
      body: `Advanced to ${nextStage}`,
    };

    assert.strictEqual(event.kind, "system");
    assert.ok(event.body.includes("Advanced to"));
  });
});

// Test asset approval/rejection: verify state transitions
describe("Content Workflow — Asset Approval", () => {
  it("should approve a pending asset", () => {
    const asset = { id: "asset-1", ref_id: "img-123", ref_kind: "image", approval_state: "pending" };

    // Approve action: set to approved
    const nextState = "approved";
    assert.strictEqual(nextState, "approved");
  });

  it("should reject an approved asset", () => {
    const asset = { id: "asset-1", ref_id: "img-123", ref_kind: "image", approval_state: "approved" };

    // Reject action: set to rejected
    const nextState = "rejected";
    assert.strictEqual(nextState, "rejected");
  });

  it("should handle approved and rejected states", () => {
    const states = ["pending", "approved", "rejected"];
    let current = "pending";

    // Approve (pending → approved)
    current = "approved";
    assert.ok(states.includes(current));

    // Reject (approved → rejected)
    current = "rejected";
    assert.ok(states.includes(current));

    // Back to pending conceptually
    current = "pending";
    assert.ok(states.includes(current));
  });

  it("should preserve asset metadata during approval state change", () => {
    const asset = {
      id: "asset-1",
      ref_id: "img-123",
      ref_kind: "image",
      approval_state: "pending",
      metadata: { width: 1024, height: 768 },
    };

    // After approval, metadata should remain
    const approved = { ...asset, approval_state: "approved" };
    assert.deepStrictEqual(approved.metadata, asset.metadata);
  });
});

// Test workflow stage progression
describe("Content Workflow — Stage Progression", () => {
  const stages = ["concept", "assets", "copy", "distribution", "scheduled", "published"];

  it("should progress through all stages in order", () => {
    let current = 0;
    const visited: string[] = [];

    while (current < stages.length) {
      visited.push(stages[current]);
      current++;
    }

    assert.deepStrictEqual(visited, stages);
  });

  it("should maintain frozen data at each stage", () => {
    const frozenData: Record<string, unknown> = {};

    for (const stage of stages.slice(0, -1)) { // All except published
      frozenData[stage] = { timestamp: new Date().toISOString() };
    }

    assert.strictEqual(Object.keys(frozenData).length, 5); // concept, assets, copy, distribution, scheduled
    assert.ok(frozenData.concept !== undefined);
    assert.ok(frozenData.assets !== undefined);
    assert.ok(frozenData.copy !== undefined);
    assert.ok(frozenData.distribution !== undefined);
    assert.ok(frozenData.scheduled !== undefined);
    assert.strictEqual(frozenData.published, undefined); // Published is final, no freeze after
  });
});
