// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { composeStagePrompt } from './workflow-tool.js';
import { WORKFLOWS, workflowById } from './workflows/index.js';
import type { StageDef } from './workflow-types.js';

const chatStage: StageDef = {
  id: 'concept', label: 'Concept', gate: 'user',
  action: { type: 'chat', basePrompt: 'Shape the concept.', skills: ['LinkedIn Strategy'], reads: ['brief'], writes: 'concept' },
};

describe('composeStagePrompt', () => {
  it('layers base + skills + brand + card, in order', () => {
    const out = composeStagePrompt(chatStage, '[BRAND KIT]\nVoice: warm', 'Brief: agents explained plainly');
    assert.ok(out.startsWith('[CONTENT DOCTRINE')); // doctrine is the stable prefix
    assert.ok(out.includes('Content Filter'));
    assert.ok(out.includes('N-of-1'));
    assert.ok(out.includes('Shape the concept.'));
    assert.ok(out.includes('Load these skills first: LinkedIn Strategy.'));
    assert.ok(out.includes('[BRAND KIT]'));
    assert.ok(out.includes('[CAMPAIGN CARD]'));
    assert.ok(out.includes('Brief: agents explained plainly'));
    assert.ok(out.includes('frozen onto the card slot "concept"'));
  });
  it('omits empty brand + card blocks', () => {
    const out = composeStagePrompt(chatStage, '', '');
    assert.ok(!out.includes('[BRAND KIT]'));
    assert.ok(!out.includes('[CAMPAIGN CARD]'));
  });
  it('returns empty for a deterministic (tool) stage', () => {
    const toolStage: StageDef = { id: 'review', label: 'Review', gate: 'user', action: { type: 'tool', tool: 'noop' } };
    assert.strictEqual(composeStagePrompt(toolStage, 'x', 'y'), '');
  });
});

describe('shipped workflows', () => {
  it('has linkedin-carousel with the expected staged pipeline', () => {
    const wf = workflowById('linkedin-carousel');
    assert.ok(wf);
    assert.deepStrictEqual(wf.stages.map((s) => s.id), ['concept', 'assets', 'copy', 'review']);
    // every stage is gated (approval to advance) and has an action
    for (const s of wf.stages) {
      assert.ok(['auto', 'user', 'agent'].includes(s.gate));
      assert.ok(s.action.type === 'chat' || s.action.type === 'tool');
    }
  });
  it('every shipped workflow has a unique id and at least one stage', () => {
    const ids = new Set<string>();
    for (const w of WORKFLOWS) {
      assert.ok(!ids.has(w.id), `duplicate workflow id ${w.id}`);
      ids.add(w.id);
      assert.ok(w.stages.length >= 1);
    }
  });
});
