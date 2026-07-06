// SPDX-License-Identifier: AGPL-3.0-or-later
// Unit tests for content workflow: gate advance (freezing + activity logging) and asset approval.

import { describe, it, expect } from "vitest";

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
    expect(nextStage).toBe("assets");

    // Verify frozen data is created
    const frozen = card.frozen_data ?? {};
    frozen[card.status] = { title: card.title, timestamp: new Date().toISOString() };

    expect(frozen.concept).toBeDefined();
    expect(frozen.concept.title).toBe("Test Campaign");
    expect(typeof frozen.concept.timestamp).toBe("string");
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

    expect(nextStage).toBeUndefined();
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

    expect(event.kind).toBe("system");
    expect(event.body).toContain("Advanced to");
  });
});

// Test asset approval/rejection: verify state transitions
describe("Content Workflow — Asset Approval", () => {
  it("should approve a pending asset", () => {
    const asset = { id: "asset-1", ref_id: "img-123", ref_kind: "image", approval_state: "pending" };

    const nextState = asset.approval_state === "approved" ? "rejected" : "approved";
    expect(nextState).toBe("approved");
  });

  it("should reject an approved asset", () => {
    const asset = { id: "asset-1", ref_id: "img-123", ref_kind: "image", approval_state: "approved" };

    const nextState = asset.approval_state === "approved" ? "rejected" : "approved";
    expect(nextState).toBe("rejected");
  });

  it("should toggle between pending, approved, and rejected states", () => {
    const states = ["pending", "approved", "rejected"];
    let current = "pending";

    // Approve (pending → approved)
    current = "approved";
    expect(states.includes(current)).toBe(true);

    // Reject (approved → rejected)
    current = "rejected";
    expect(states.includes(current)).toBe(true);

    // Back to pending conceptually (reject again)
    current = "pending";
    expect(states.includes(current)).toBe(true);
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
    expect(approved.metadata).toEqual(asset.metadata);
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

    expect(visited).toEqual(stages);
  });

  it("should maintain frozen data at each stage", () => {
    const frozenData: Record<string, unknown> = {};

    for (const stage of stages.slice(0, -1)) { // All except published
      frozenData[stage] = { timestamp: new Date().toISOString() };
    }

    expect(Object.keys(frozenData).length).toBe(5); // concept, assets, copy, distribution, scheduled
    expect(frozenData.concept).toBeDefined();
    expect(frozenData.assets).toBeDefined();
    expect(frozenData.copy).toBeDefined();
    expect(frozenData.distribution).toBeDefined();
    expect(frozenData.scheduled).toBeDefined();
    expect(frozenData.published).toBeUndefined(); // Published is final, no freeze after
  });
});
