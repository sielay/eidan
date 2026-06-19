// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSearchQuery,
  exportMimeFor,
  isGoogleNative,
  isTextualMime,
  normalizeFile,
} from './drive.js';

describe('normalizeFile', () => {
  it('maps a full Drive file record to the normalized shape', () => {
    const f = normalizeFile({
      id: 'abc123',
      name: 'Quarterly plan',
      mimeType: 'application/vnd.google-apps.document',
      modifiedTime: '2026-06-10T08:30:00.000Z',
      size: '4096',
      owners: [{ displayName: 'Ada Lovelace', emailAddress: 'ada@example.com' }],
      webViewLink: 'https://docs.google.com/d/abc123',
    });
    assert.deepEqual(f, {
      id: 'abc123',
      name: 'Quarterly plan',
      mimeType: 'application/vnd.google-apps.document',
      modifiedTime: '2026-06-10T08:30:00.000Z',
      size: 4096,
      owner: 'Ada Lovelace',
      webViewLink: 'https://docs.google.com/d/abc123',
    });
  });

  it('defaults missing fields and falls back owner name → email → null', () => {
    assert.equal(normalizeFile({}).owner, null);
    assert.equal(normalizeFile({ owners: [{ emailAddress: 'x@y.z' }] }).owner, 'x@y.z');
    const empty = normalizeFile({});
    assert.equal(empty.id, '');
    assert.equal(empty.name, '');
    assert.equal(empty.modifiedTime, null);
    assert.equal(empty.webViewLink, null);
  });

  it('parses size as a number, leaving non-numeric/absent size as null', () => {
    assert.equal(normalizeFile({ size: '0' }).size, 0);
    assert.equal(normalizeFile({ size: '' }).size, null);
    assert.equal(normalizeFile({ size: 'not-a-number' }).size, null);
    assert.equal(normalizeFile({}).size, null);
  });
});

describe('Google-native export mapping', () => {
  it('recognizes Docs/Sheets/Slides as native', () => {
    assert.equal(isGoogleNative('application/vnd.google-apps.document'), true);
    assert.equal(isGoogleNative('application/vnd.google-apps.spreadsheet'), true);
    assert.equal(isGoogleNative('application/vnd.google-apps.presentation'), true);
    assert.equal(isGoogleNative('text/plain'), false);
    assert.equal(isGoogleNative('application/pdf'), false);
  });

  it('exports Docs/Slides to plain text and Sheets to CSV', () => {
    assert.equal(exportMimeFor('application/vnd.google-apps.document'), 'text/plain');
    assert.equal(exportMimeFor('application/vnd.google-apps.presentation'), 'text/plain');
    assert.equal(exportMimeFor('application/vnd.google-apps.spreadsheet'), 'text/csv');
    assert.equal(exportMimeFor('application/pdf'), null);
  });
});

describe('isTextualMime', () => {
  it('accepts text/* and known structured-text types', () => {
    assert.equal(isTextualMime('text/plain'), true);
    assert.equal(isTextualMime('text/markdown'), true);
    assert.equal(isTextualMime('application/json'), true);
    assert.equal(isTextualMime('application/xml'), true);
  });

  it('ignores charset parameters and is case-insensitive', () => {
    assert.equal(isTextualMime('text/plain; charset=utf-8'), true);
    assert.equal(isTextualMime('Application/JSON'), true);
  });

  it('rejects binary types', () => {
    assert.equal(isTextualMime('application/pdf'), false);
    assert.equal(isTextualMime('image/png'), false);
    assert.equal(isTextualMime('application/octet-stream'), false);
  });
});

describe('buildSearchQuery', () => {
  it('always excludes folders and trashed files', () => {
    const q = buildSearchQuery();
    assert.ok(q.includes('trashed = false'));
    assert.ok(q.includes("mimeType != 'application/vnd.google-apps.folder'"));
    assert.ok(!q.includes('contains'));
  });

  it('matches a term against name and full-text content', () => {
    const q = buildSearchQuery('budget');
    assert.ok(q.includes("name contains 'budget'"));
    assert.ok(q.includes("fullText contains 'budget'"));
  });

  it('escapes single quotes and backslashes to avoid query injection', () => {
    const q = buildSearchQuery("o'brien\\report");
    assert.ok(q.includes("name contains 'o\\'brien\\\\report'"));
  });

  it('treats a whitespace-only term as no term', () => {
    assert.equal(buildSearchQuery('   '), buildSearchQuery());
  });
});
