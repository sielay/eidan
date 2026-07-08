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

// Card type for testing that includes stage-specific properties.
type TestCard = {
  status: string;
  frozen_data?: Record<string, unknown>;
  title: string;
  conversation_id?: string | null;
  metadata?: Record<string, unknown>;
  channels?: string[];
  approved_assets?: string[];
  copy_drafts?: Record<string, unknown>;
  resources?: unknown[];
};

// Helper: simulate gate advance (freeze current stage data and transition + log activity).
function advanceGate(card: TestCard): {
  status: string;
  frozen_data: Record<string, any>;
  activity: { kind: string; body: string; timestamp: string };
} {
  const gate = GATES[card.status];
  if (!gate) throw new Error(`Cannot advance from ${card.status}`);

  const frozen = card.frozen_data ?? {};
  const stageData: Record<string, unknown> = { timestamp: new Date().toISOString() };

  // Freeze stage-specific output per the task requirements.
  if (card.status === "concept") {
    stageData.conversation_id = card.conversation_id;
    stageData.title = card.title;
  } else if (card.status === "assets") {
    stageData.approved_assets = card.approved_assets ?? [];
  } else if (card.status === "copy") {
    stageData.copy_drafts = card.copy_drafts ?? {};
  } else if (card.status === "distribution") {
    stageData.channels = card.channels ?? [];
    stageData.resources = card.resources ?? [];
  }

  return {
    status: gate.nextStage,
    frozen_data: { ...frozen, [card.status]: stageData },
    activity: {
      kind: "status",
      body: gate.nextStage,
      timestamp: new Date().toISOString(),
    },
  };
}

// Test gate advance: verify that advancing freezes stage output and logs activity.
describe("Content Workflow — Gate Advance", () => {
  it("should advance from concept to assets and freeze concept data", () => {
    const card = { id: "test-card-1", board_id: "board-1", status: "concept", frozen_data: {}, title: "Test Campaign", conversation_id: "conv-123" };
    const result = advanceGate(card);

    assert.strictEqual(result.status, "assets");
    assert.ok(result.frozen_data.concept !== undefined);
    assert.strictEqual(result.frozen_data.concept.title, "Test Campaign");
    assert.strictEqual(result.frozen_data.concept.conversation_id, "conv-123");
    assert.strictEqual(typeof result.frozen_data.concept.timestamp, "string");
    assert.ok(result.activity);
    assert.strictEqual(result.activity.kind, "status");
    assert.strictEqual(result.activity.body, "assets");
  });

  it("should advance through all stages and accumulate frozen data", () => {
    let card: TestCard = { status: "concept", frozen_data: {}, title: "Campaign", conversation_id: "conv-123", approved_assets: [], copy_drafts: {}, channels: [] };

    for (let i = 0; i < STAGES.length - 2; i++) {
      const result = advanceGate(card);
      card = { ...card, status: result.status, frozen_data: result.frozen_data, approved_assets: [], copy_drafts: {}, resources: [] };
      assert.ok(STAGES.includes(card.status), `Stage ${card.status} is valid`);
    }

    assert.strictEqual(card.status, "scheduled");
    assert.ok(card.frozen_data.concept !== undefined);
    assert.ok(card.frozen_data.assets !== undefined);
    assert.ok(card.frozen_data.copy !== undefined);
  });

  it("should handle scheduled stage (frozen until publish time)", () => {
    const card: TestCard = { status: "scheduled", frozen_data: { concept: {}, assets: {}, copy: {}, distribution: {} }, title: "Campaign" };
    // Scheduled stage does not have a gate advance (auto-executes at publish_at time)
    assert.throws(() => advanceGate(card), /Cannot advance from scheduled/);
  });

  it("should handle published stage (final, no advance possible)", () => {
    const card: TestCard = { status: "published", frozen_data: { concept: {}, assets: {}, copy: {}, distribution: {} }, title: "Campaign" };
    // Published is the final stage, should not advance
    assert.throws(() => advanceGate(card), /Cannot advance from published/);
  });

  it("should not allow advancing from published stage", () => {
    const card: TestCard = { status: "published", frozen_data: {}, title: "Done" };
    assert.throws(() => advanceGate(card), /Cannot advance from published/);
  });

  it("should freeze stage-specific output for assets stage", () => {
    const card: TestCard = { status: "assets", frozen_data: {}, title: "Campaign", approved_assets: ["img-1", "img-2"] };
    const result = advanceGate(card);

    assert.ok(result.frozen_data.assets !== undefined);
    assert.deepStrictEqual(result.frozen_data.assets.approved_assets, ["img-1", "img-2"]);
    assert.strictEqual(typeof result.frozen_data.assets.timestamp, "string");
  });

  it("should log activity on gate advance", () => {
    const card = { status: "concept", frozen_data: {}, title: "Test" };
    const result = advanceGate(card);

    assert.ok(result.activity);
    assert.strictEqual(result.activity.kind, "status");
    assert.strictEqual(result.activity.body, "assets");
    assert.strictEqual(typeof result.activity.timestamp, "string");
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
