// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';

// Import drive.ts helpers to test CSV parsing without mocking complexity
import { parseCSV } from './csv-parser.js';

// Test the CSV parsing behavior integrated into the tool logic
interface ToolResult {
  type: 'result' | 'error';
  value?: unknown;
  message?: string;
}

// Simplified tool executor simulation that tests CSV parsing
async function* simulateGdriveReadFileTool(
  fileId: string,
  format: string,
  mimeType: string,
  text: string,
): AsyncGenerator<ToolResult> {
  const validFormats = ['text', 'csv', 'table'];
  const normalizedFormat = format.toLowerCase();

  if (!validFormats.includes(normalizedFormat)) {
    yield { type: 'error', message: 'format must be "text", "csv", or "table"' };
    return;
  }

  const file = {
    id: fileId,
    name: 'test-file',
    mimeType,
    modifiedTime: '2024-01-01T00:00:00Z',
    owner: 'test@example.com',
    webViewLink: 'https://drive.google.com/file/d/' + fileId,
  };

  if (normalizedFormat === 'text') {
    const truncated = text.length > 16000;
    yield {
      type: 'result',
      value: {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        modifiedTime: file.modifiedTime,
        owner: file.owner,
        webViewLink: file.webViewLink,
        truncated,
        content: truncated ? text.slice(0, 16000) : text,
      },
    };
    return;
  }

  const isCsvExportable = mimeType === 'application/vnd.google-apps.spreadsheet' ||
                          mimeType === 'text/csv' ||
                          mimeType === 'application/csv';

  if (!isCsvExportable) {
    yield {
      type: 'result',
      value: {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        modifiedTime: file.modifiedTime,
        owner: file.owner,
        webViewLink: file.webViewLink,
        note: `format="${normalizedFormat}" only works with Google Sheets or CSV files; returning raw text instead`,
        content: text.length > 16000 ? text.slice(0, 16000) : text,
        truncated: text.length > 16000,
      },
    };
    return;
  }

  const parsed = parseCSV(text);

  if (normalizedFormat === 'csv') {
    yield {
      type: 'result',
      value: {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        modifiedTime: file.modifiedTime,
        owner: file.owner,
        webViewLink: file.webViewLink,
        content: parsed.rows,
      },
    };
  } else if (normalizedFormat === 'table') {
    yield {
      type: 'result',
      value: {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        modifiedTime: file.modifiedTime,
        owner: file.owner,
        webViewLink: file.webViewLink,
        headers: parsed.headers,
        rows: parsed.rows,
      },
    };
  }
}

describe('gdrive_read_file tool format behavior', () => {
  it('returns raw text when format is "text" (default)', async () => {
    const results: ToolResult[] = [];
    for await (const result of simulateGdriveReadFileTool('file1', 'text', 'text/plain', 'Hello, World!')) {
      results.push(result);
    }

    assert.equal(results.length, 1);
    const result = results[0]!;
    assert.equal(result.type, 'result');
    assert.equal((result.value as any)?.content, 'Hello, World!');
    assert.equal((result.value as any)?.truncated, false);
  });

  it('returns structured CSV format when requested', async () => {
    const results: ToolResult[] = [];
    for await (const result of simulateGdriveReadFileTool('sheet1', 'csv', 'text/csv', 'name,age,active\nAlice,30,true\nBob,25,false')) {
      results.push(result);
    }

    assert.equal(results.length, 1);
    const result = results[0]!;
    assert.equal(result.type, 'result');
    const content = (result.value as any)?.content;
    assert.equal(Array.isArray(content), true);
    assert.equal(content.length, 2);
    assert.deepEqual(content[0], { name: 'Alice', age: 30, active: true });
  });

  it('returns structured table format with headers and rows', async () => {
    const results: ToolResult[] = [];
    for await (const result of simulateGdriveReadFileTool(
      'sheet2',
      'table',
      'application/vnd.google-apps.spreadsheet',
      'category,amount,approved\nOffice Supplies,150.50,true\nTravel,5000,false',
    )) {
      results.push(result);
    }

    assert.equal(results.length, 1);
    const result = results[0]!;
    assert.equal(result.type, 'result');
    const value = result.value as any | undefined;
    assert.deepEqual(value?.headers, ['category', 'amount', 'approved']);
    assert.equal(Array.isArray(value?.rows), true);
    assert.equal(value.rows.length, 2);
    assert.deepEqual(value.rows[0], { category: 'Office Supplies', amount: 150.5, approved: true });
  });

  it('returns raw text for non-CSV files even when format="csv"', async () => {
    const results: ToolResult[] = [];
    for await (const result of simulateGdriveReadFileTool('doc1', 'csv', 'text/plain', 'This is plain text content')) {
      results.push(result);
    }

    assert.equal(results.length, 1);
    const result = results[0]!;
    assert.equal(result.type, 'result');
    const value = result.value as any | undefined;
    assert.equal(value?.content, 'This is plain text content');
    assert(value?.note?.includes('format="csv" only works with Google Sheets or CSV files'));
  });

  it('handles Google Sheets MIME type in CSV format', async () => {
    const results: ToolResult[] = [];
    for await (const result of simulateGdriveReadFileTool(
      'gsheet1',
      'csv',
      'application/vnd.google-apps.spreadsheet',
      'product,q1,q2,q3,q4\nProduct A,100,120,150,180\nProduct B,200,210,220,235',
    )) {
      results.push(result);
    }

    assert.equal(results.length, 1);
    const result = results[0]!;
    const content = (result.value as any)?.content;
    assert.equal(Array.isArray(content), true);
    assert.equal(content[0]?.q1, 100);
  });

  it('handles application/csv MIME type', async () => {
    const results: ToolResult[] = [];
    for await (const result of simulateGdriveReadFileTool('csv1', 'table', 'application/csv', 'id,value\n1,100\n2,200')) {
      results.push(result);
    }

    assert.equal(results.length, 1);
    const result = results[0]!;
    assert.equal(result.type, 'result');
    assert.deepEqual((result.value as any)?.headers, ['id', 'value']);
  });

  it('reports error for invalid format parameter', async () => {
    const results: ToolResult[] = [];
    for await (const result of simulateGdriveReadFileTool('file1', 'invalid', 'text/plain', 'content')) {
      results.push(result);
    }

    assert.equal(results.length, 1);
    const result = results[0]!;
    assert.equal(result.type, 'error');
    assert(result.message?.includes('format must be'));
  });

  it('handles empty CSV (header only)', async () => {
    const results: ToolResult[] = [];
    for await (const result of simulateGdriveReadFileTool('empty1', 'csv', 'text/csv', 'col1,col2,col3')) {
      results.push(result);
    }

    assert.equal(results.length, 1);
    const result = results[0]!;
    assert.equal(result.type, 'result');
    assert.deepEqual((result.value as any)?.content, []);
  });

  it('parses mixed data types in CSV', async () => {
    const results: ToolResult[] = [];
    for await (const result of simulateGdriveReadFileTool(
      'mixed1',
      'csv',
      'text/csv',
      'name,count,price,available\nItem A,5,19.99,true\nItem B,0,,false',
    )) {
      results.push(result);
    }

    assert.equal(results.length, 1);
    const rows = (results[0]!.value as any)?.content;
    assert.equal(rows[0]?.count, 5);
    assert.equal(rows[0]?.price, 19.99);
    assert.equal(rows[0]?.available, true);
    assert.equal(rows[1]?.count, 0);
    assert.equal(rows[1]?.price, '');
    assert.equal(rows[1]?.available, false);
  });

  it('handles format parameter case-insensitively', async () => {
    const results: ToolResult[] = [];
    for await (const result of simulateGdriveReadFileTool('file1', 'CSV', 'text/csv', 'a,b\n1,2')) {
      results.push(result);
    }

    assert.equal(results.length, 1);
    const result = results[0]!;
    assert.equal(result.type, 'result');
    assert(Array.isArray((result.value as any)?.content));
  });
});
