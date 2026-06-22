// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeckTools } from './tools.js';

describe('buildDeckTools', () => {
  it('returns an array with the render_deck tool', () => {
    const tools = buildDeckTools();
    assert.equal(Array.isArray(tools), true);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'render_deck');
  });

  it('render_deck tool has proper description', () => {
    const tools = buildDeckTools();
    const tool = tools[0];
    assert.ok(tool.description.includes('Marp markdown'));
    assert.ok(tool.description.includes('pptx/html/pdf'));
  });

  it('render_deck tool has executor function', () => {
    const tools = buildDeckTools();
    const tool = tools[0];
    assert.ok(tool.executor);
    assert.ok(typeof tool.executor.execute === 'function');
  });

  it('input schema requires markdown and filename', () => {
    const tools = buildDeckTools();
    const schema = tools[0].inputSchema;
    assert.ok(schema.required);
    assert.ok(schema.required.includes('markdown'));
    assert.ok(schema.required.includes('filename'));
  });

  it('input schema has markdown property', () => {
    const tools = buildDeckTools();
    const schema = tools[0].inputSchema;
    assert.ok(schema.properties.markdown);
    assert.equal(schema.properties.markdown.type, 'string');
    assert.equal(schema.properties.markdown.minLength, 1);
  });

  it('input schema has filename property', () => {
    const tools = buildDeckTools();
    const schema = tools[0].inputSchema;
    assert.ok(schema.properties.filename);
    assert.equal(schema.properties.filename.type, 'string');
    assert.equal(schema.properties.filename.minLength, 1);
  });

  it('input schema has optional title property', () => {
    const tools = buildDeckTools();
    const schema = tools[0].inputSchema;
    assert.ok(schema.properties.title);
    assert.equal(schema.properties.title.type, 'string');
  });

  it('input schema has optional formats array', () => {
    const tools = buildDeckTools();
    const schema = tools[0].inputSchema;
    assert.ok(schema.properties.formats);
    assert.equal(schema.properties.formats.type, 'array');
    assert.ok(schema.properties.formats.items.enum);
    assert.ok(schema.properties.formats.items.enum.includes('html'));
    assert.ok(schema.properties.formats.items.enum.includes('pptx'));
    assert.ok(schema.properties.formats.items.enum.includes('pdf'));
  });

  it('input schema disallows additional properties', () => {
    const tools = buildDeckTools();
    const schema = tools[0].inputSchema;
    assert.equal(schema.additionalProperties, false);
  });
});
