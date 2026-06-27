// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { detectFormatParser, ParseError } from './parsers.js';

describe('detectFormatParser', () => {
  it('detects PDF format from MIME type', () => {
    const parser = detectFormatParser('application/pdf');
    assert.ok(parser !== null, 'should return a parser for PDF MIME type');
  });

  it('detects image format from MIME type and returns OCR parser', () => {
    const pngParser = detectFormatParser('image/png');
    const jpgParser = detectFormatParser('image/jpeg');
    const gifParser = detectFormatParser('image/gif');

    assert.ok(pngParser !== null, 'should return a parser for PNG');
    assert.ok(jpgParser !== null, 'should return a parser for JPG');
    assert.ok(gifParser !== null, 'should return a parser for GIF');
  });

  it('detects DOCX format from MIME type', () => {
    const parser = detectFormatParser(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    assert.ok(parser !== null, 'should return a parser for DOCX MIME type');
  });

  it('detects legacy DOCX format (.doc)', () => {
    const parser = detectFormatParser('application/msword');
    assert.ok(parser !== null, 'should return a parser for legacy DOC');
  });

  it('detects Excel format from MIME type', () => {
    const parser = detectFormatParser(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    assert.ok(parser !== null, 'should return a parser for XLSX MIME type');
  });

  it('detects legacy Excel format (.xls)', () => {
    const parser = detectFormatParser('application/vnd.ms-excel');
    assert.ok(parser !== null, 'should return a parser for legacy XLS');
  });

  it('respects explicit format parameter over MIME type detection', () => {
    const pdfParser = detectFormatParser('image/png', 'pdf');
    const ocrParser = detectFormatParser('application/pdf', 'ocr');

    assert.ok(pdfParser !== null, 'should use pdf parser when explicitly requested');
    assert.ok(ocrParser !== null, 'should use ocr parser when explicitly requested');
  });

  it('returns null for unsupported MIME types with no format param', () => {
    const parser = detectFormatParser('application/octet-stream');
    assert.equal(parser, null);
  });

  it('returns null for invalid format parameter', () => {
    const parser = detectFormatParser('application/pdf', 'invalid-format');
    assert.equal(parser, null);
  });

  it('case-insensitive format parameter handling', () => {
    const pdfLower = detectFormatParser('application/pdf', 'pdf');
    const pdfUpper = detectFormatParser('application/pdf', 'PDF');
    const pdfMixed = detectFormatParser('application/pdf', 'PdF');

    assert.ok(pdfLower !== null);
    assert.ok(pdfUpper !== null);
    assert.ok(pdfMixed !== null);
  });

  it('ignores charset parameters in MIME type', () => {
    const parser = detectFormatParser('application/pdf; charset=utf-8');
    assert.ok(parser !== null, 'should detect PDF ignoring charset');
  });

  it('handles MIME type case-insensitivity', () => {
    const parser1 = detectFormatParser('Application/PDF');
    const parser2 = detectFormatParser('IMAGE/PNG');

    assert.ok(parser1 !== null);
    assert.ok(parser2 !== null);
  });
});

describe('ParseError', () => {
  it('is an Error subclass', () => {
    const err = new ParseError('test error');
    assert.ok(err instanceof Error);
    assert.equal(err.message, 'test error');
  });
});
