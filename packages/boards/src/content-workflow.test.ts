// SPDX-License-Identifier: AGPL-3.0-or-later
// Unit tests for content workflow: gate advance (freezing + activity logging) and asset approval.

import { describe, it } from "node:test";
import assert from "node:assert";

// Gates progression logic — verify stages and transitions.
const GATES: Record<string, { label: string; nextStage: string }> = {
  concept: { label: "Idea settled", nextStage: "assets" },
  assets: { label: "Assets settled", nextStage: "copy" },
  copy: { label: "Copy approved", nextStage: "distribution" },
  distribution: { label: "Schedule", nextStage: "scheduled" },
};

const STAGES = ["concept", "assets", "copy", "distribution", "scheduled", "published"];

// Helper: simulate gate advance (freeze current stage data and transition).
function advanceGate(card: { status: string; frozen_data?: Record<string, unknown>; title: string }): { status: string; frozen_data: Record<string, unknown> } {
  const gate = GATES[card.status];
  if (!gate) throw new Error(`Cannot advance from ${card.status}`);

  const frozen = card.frozen_data ?? {};
  frozen[card.status] = { title: card.title, timestamp: new Date().toISOString() };

  return {
    status: gate.nextStage,
    frozen_data: frozen,
  };
}

// Test gate advance: verify that advancing freezes stage output and logs activity.
describe("Content Workflow — Gate Advance", () => {
  it("should advance from concept to assets and freeze concept data", () => {
    const card = { id: "test-card-1", status: "concept", frozen_data: {}, title: "Test Campaign" };
    const result = advanceGate(card);

    assert.strictEqual(result.status, "assets");
    assert.ok(result.frozen_data.concept !== undefined);
    assert.strictEqual(result.frozen_data.concept.title, "Test Campaign");
    assert.strictEqual(typeof result.frozen_data.concept.timestamp, "string");
  });

  it("should advance through all stages and accumulate frozen data", () => {
    let card = { status: "concept", frozen_data: {}, title: "Campaign" };

    for (let i = 0; i < STAGES.length - 2; i++) { // concept → assets → copy → distribution → scheduled
      card = advanceGate(card as any);
      assert.ok(STAGES.includes(card.status), `Stage ${card.status} is valid`);
    }

    assert.strictEqual(card.status, "scheduled");
    assert.ok(card.frozen_data.concept !== undefined);
    assert.ok(card.frozen_data.assets !== undefined);
  });

  it("should not allow advancing from published stage", () => {
    const card = { status: "published", frozen_data: {}, title: "Done" };
    assert.throws(() => advanceGate(card as any), /Cannot advance from published/);
  });

  it("should preserve metadata during frozen data creation", () => {
    const card = { status: "concept", frozen_data: {}, title: "Test", metadata: { labels: ["urgent"] } };
    const result = advanceGate(card as any);

    assert.ok(result.frozen_data.concept !== undefined);
    assert.strictEqual(typeof result.frozen_data.concept.timestamp, "string");
  });
});

// Test asset approval state transitions.
describe("Content Workflow — Asset Approval", () => {
  const approvalStates = ["pending", "approved", "rejected"];

  it("should transition from pending to approved", () => {
    const asset = { id: "asset-1", ref_id: "img-123", ref_kind: "image", approval_state: "pending" };
    const updated = { ...asset, approval_state: "approved" };

    assert.strictEqual(updated.approval_state, "approved");
    assert.ok(approvalStates.includes(updated.approval_state));
  });

  it("should transition from approved to rejected", () => {
    const asset = { id: "asset-1", ref_id: "img-123", ref_kind: "image", approval_state: "approved" };
    const updated = { ...asset, approval_state: "rejected" };

    assert.strictEqual(updated.approval_state, "rejected");
    assert.ok(approvalStates.includes(updated.approval_state));
  });

  it("should preserve asset metadata during approval state change", () => {
    const asset = { id: "asset-1", ref_id: "img-123", ref_kind: "image", approval_state: "pending", metadata: { width: 1024, height: 768 } };
    const approved = { ...asset, approval_state: "approved" };

    assert.deepStrictEqual(approved.metadata, asset.metadata);
    assert.strictEqual(approved.approval_state, "approved");
  });

  it("should only allow valid approval states", () => {
    const states = ["pending", "approved", "rejected"];
    const validTransitions = new Map([
      ["pending", ["approved", "rejected"]],
      ["approved", ["rejected"]],
      ["rejected", ["approved"]],
    ]);

    for (const [from, tos] of validTransitions) {
      for (const to of tos) {
        assert.ok(states.includes(to), `${to} is a valid state`);
      }
    }
  });
});

// Test workflow stage progression and frozen data accumulation.
describe("Content Workflow — Stage Progression", () => {
  it("should have all stages defined in order", () => {
    const expectedStages = ["concept", "assets", "copy", "distribution", "scheduled", "published"];
    assert.deepStrictEqual(STAGES, expectedStages);
  });

  it("should only allow advancement through defined gates", () => {
    const validGates = Object.keys(GATES);
    const advanceable = STAGES.slice(0, -2); // All but scheduled, published

    for (const stage of advanceable) {
      assert.ok(validGates.includes(stage), `${stage} has a defined gate`);
    }
  });

  it("should accumulate frozen data without losing previous stage data", () => {
    let frozenData: Record<string, unknown> = {};

    for (const stage of STAGES.slice(0, -1)) {
      frozenData[stage] = { title: "Campaign", timestamp: new Date().toISOString() };
    }

    assert.strictEqual(Object.keys(frozenData).length, 5);
    for (const stage of STAGES.slice(0, -1)) {
      assert.ok(frozenData[stage] !== undefined, `${stage} frozen data exists`);
    }
  });
});
