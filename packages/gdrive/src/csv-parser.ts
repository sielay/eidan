// SPDX-License-Identifier: AGPL-3.0-or-later
// CSV parsing utilities for gdrive_read_file format parameter.

interface ParsedTable {
  headers: string[];
  rows: Record<string, unknown>[];
}

// Try to parse a value as a number or date; fall back to string for ambiguous values.
// Values with leading zeros are kept as strings (codes, zip codes, etc).
function parseValue(val: string): number | boolean | string {
  if (val === '') return '';
  if (val.toLowerCase() === 'true') return true;
  if (val.toLowerCase() === 'false') return false;
  const trimmed = val.trim();
  if (trimmed === '') return val;
  // Preserve leading zeros (indicates a code, not a number)
  if (trimmed.length > 1 && trimmed[0] === '0' && /^\d+$/.test(trimmed)) return val;
  const num = Number(val);
  if (!Number.isNaN(num)) return num;
  return val;
}

// Simple RFC 4180 CSV parser. Handles quoted fields, escaped quotes, CRLF/LF line endings.
export function parseCSV(csvText: string): ParsedTable {
  const lines = csvText.split(/\r?\n/);
  const rows: Record<string, unknown>[] = [];
  let headers: string[] = [];
  let headersParsed = false;

  for (const line of lines) {
    if (line.trim() === '') continue;

    const fieldsWithQuoteInfo = parseCSVLine(line);
    if (!headersParsed) {
      headers = fieldsWithQuoteInfo.map((f) => f.value);
      headersParsed = true;
      continue;
    }

    const row: Record<string, unknown> = {};
    for (let i = 0; i < headers.length; i++) {
      const header = headers[i];
      if (!header) continue;
      const fieldInfo = fieldsWithQuoteInfo[i] ?? { value: '', wasQuoted: false };
      // Quoted fields stay as strings; unquoted fields get type inference
      row[header] = fieldInfo.wasQuoted ? fieldInfo.value : parseValue(fieldInfo.value);
    }
    rows.push(row);
  }

  return { headers, rows };
}

interface FieldInfo {
  value: string;
  wasQuoted: boolean;
}

// Parse a single CSV line respecting quoted fields and RFC 4180 escaping.
// Quoted fields preserve internal whitespace; unquoted fields are trimmed.
function parseCSVLine(line: string): FieldInfo[] {
  const fields: FieldInfo[] = [];
  let current = '';
  let inQuotes = false;
  let wasQuoted = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 2;
        continue;
      }
      if (!inQuotes) {
        wasQuoted = true;
      }
      inQuotes = !inQuotes;
      i++;
      continue;
    }

    if (char === ',' && !inQuotes) {
      fields.push({ value: wasQuoted ? current : current.trim(), wasQuoted });
      current = '';
      wasQuoted = false;
      i++;
      continue;
    }

    current += char;
    i++;
  }

  fields.push({ value: wasQuoted ? current : current.trim(), wasQuoted });
  return fields;
}
