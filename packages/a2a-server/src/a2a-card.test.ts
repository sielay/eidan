// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { agentCard } from './a2a-card.js';

describe('agentCard', () => {
  const card = agentCard({ name: 'eidan', description: 'a personal agent', url: 'https://example.com/a2a' });

  it('carries the identity from opts', () => {
    assert.equal(card['name'], 'eidan');
    assert.equal(card['description'], 'a personal agent');
    assert.equal(card['url'], 'https://example.com/a2a');
  });

  it('declares the A2A protocol fields', () => {
    assert.equal(card['protocolVersion'], '0.2.5');
    assert.deepEqual(card['capabilities'], { streaming: false, pushNotifications: false });
    assert.deepEqual(card['defaultInputModes'], ['text']);
    assert.deepEqual(card['defaultOutputModes'], ['text']);
  });

  it('exposes the chat skill', () => {
    const skills = card['skills'] as Array<{ id: string; tags: string[] }>;
    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.id, 'chat');
    assert.ok(skills[0]?.tags.includes('memory'));
  });
});
