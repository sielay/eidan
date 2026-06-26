// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV } from './csv-parser.js';

describe('parseCSV', () => {
  it('parses a simple CSV with headers and data', () => {
    const csv = 'name,age,active\nAlice,30,true\nBob,25,false';
    const { headers, rows } = parseCSV(csv);

    assert.deepEqual(headers, ['name', 'age', 'active']);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { name: 'Alice', age: 30, active: true });
    assert.deepEqual(rows[1], { name: 'Bob', age: 25, active: false });
  });

  it('handles quoted fields with commas', () => {
    const csv = 'name,address\nAlice,"123 Main St, Apt 4"\nBob,"456 Oak Ave, Suite 100"';
    const { headers, rows } = parseCSV(csv);

    assert.deepEqual(headers, ['name', 'address']);
    assert.equal(rows[0]?.address, '123 Main St, Apt 4');
    assert.equal(rows[1]?.address, '456 Oak Ave, Suite 100');
  });

  it('handles escaped quotes within quoted fields', () => {
    const csv = 'title,description\nTest,"He said ""hello"" to me"';
    const { headers, rows } = parseCSV(csv);

    assert.equal(rows[0]?.description, 'He said "hello" to me');
  });

  it('parses numbers and booleans correctly', () => {
    const csv = 'id,value,flag\n1,3.14,true\n2,42,false';
    const { rows } = parseCSV(csv);

    assert.equal(rows[0]?.id, 1);
    assert.equal(rows[0]?.value, 3.14);
    assert.equal(rows[0]?.flag, true);
    assert.equal(rows[1]?.id, 2);
    assert.equal(rows[1]?.value, 42);
    assert.equal(rows[1]?.flag, false);
  });

  it('preserves leading zeros (indicates codes), quoted fields always stay as strings', () => {
    const csv = 'code,zip,normal_num\nABC,02134,123\n001,09876,456';
    const { rows } = parseCSV(csv);

    assert.equal(rows[0]?.code, 'ABC');
    assert.equal(rows[0]?.zip, '02134');
    assert.equal(rows[0]?.normal_num, 123);
    assert.equal(rows[1]?.code, '001');
    assert.equal(rows[1]?.zip, '09876');
    assert.equal(rows[1]?.normal_num, 456);
  });

  it('handles empty cells as empty strings', () => {
    const csv = 'name,email,phone\nAlice,alice@example.com,\nBob,,555-1234';
    const { rows } = parseCSV(csv);

    assert.equal(rows[0]?.name, 'Alice');
    assert.equal(rows[0]?.phone, '');
    assert.equal(rows[1]?.email, '');
    assert.equal(rows[1]?.phone, '555-1234');
  });

  it('handles rows with fewer columns than headers', () => {
    const csv = 'a,b,c\n1,2\n3,4,5';
    const { rows } = parseCSV(csv);

    assert.equal(rows[0]?.a, 1);
    assert.equal(rows[0]?.b, 2);
    assert.equal(rows[0]?.c, '');
    assert.equal(rows[1]?.c, 5);
  });

  it('ignores empty lines', () => {
    const csv = 'name,value\n\nAlice,1\n\n\nBob,2\n';
    const { rows } = parseCSV(csv);

    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.name, 'Alice');
  });

  it('handles CRLF line endings', () => {
    const csv = 'name,age\r\nAlice,30\r\nBob,25';
    const { rows } = parseCSV(csv);

    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.name, 'Alice');
  });

  it('parses single row (no data)', () => {
    const csv = 'col1,col2,col3';
    const { headers, rows } = parseCSV(csv);

    assert.deepEqual(headers, ['col1', 'col2', 'col3']);
    assert.equal(rows.length, 0);
  });

  it('handles mixed data types in a column', () => {
    const csv = 'value\n123\n3.14\nhello\ntrue';
    const { rows } = parseCSV(csv);

    assert.equal(rows[0]?.value, 123);
    assert.equal(rows[1]?.value, 3.14);
    assert.equal(rows[2]?.value, 'hello');
    assert.equal(rows[3]?.value, true);
  });

  it('handles whitespace trimming in unquoted fields', () => {
    const csv = 'name , age \n Alice , 30 \n Bob , 25 ';
    const { rows } = parseCSV(csv);

    assert.equal(rows[0]?.name, 'Alice');
    assert.equal(rows[0]?.age, 30);
  });

  it('preserves whitespace inside quoted fields', () => {
    const csv = 'name,description\n"  Alice  "," description with spaces "';
    const { rows } = parseCSV(csv);

    assert.equal(rows[0]?.name, '  Alice  ');
    assert.equal(rows[0]?.description, ' description with spaces ');
  });

  it('handles false and true case-insensitively', () => {
    const csv = 'bool1,bool2,bool3,bool4\nTrue,FALSE,tRuE,FaLsE';
    const { rows } = parseCSV(csv);

    assert.equal(rows[0]?.bool1, true);
    assert.equal(rows[0]?.bool2, false);
    assert.equal(rows[0]?.bool3, true);
    assert.equal(rows[0]?.bool4, false);
  });
});
