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

// RFC 4180 CSV parser. First row is the header; quoted fields stay strings, unquoted get type
// inference. Tokenises the WHOLE text in one pass so a quoted field can contain commas, newlines and
// escaped quotes ("") — a line-by-line split would corrupt multi-line cells (Google Sheets exports them).
export function parseCSV(csvText: string): ParsedTable {
  // Drop wholly-blank rows (a single empty unquoted field) the way blank lines were skipped before.
  const table = tokenizeCSV(csvText).filter((r) => !(r.length === 1 && r[0]?.value === '' && !r[0]?.wasQuoted));
  if (table.length === 0) return { headers: [], rows: [] };

  const headers = table[0]!.map((f) => f.value);
  const rows: Record<string, unknown>[] = [];
  for (let r = 1; r < table.length; r++) {
    const fields = table[r]!;
    const row: Record<string, unknown> = {};
    for (let i = 0; i < headers.length; i++) {
      const header = headers[i];
      if (!header) continue;
      const fieldInfo = fields[i] ?? { value: '', wasQuoted: false };
      // Quoted fields stay as strings; unquoted fields get type inference.
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

// Single-pass tokeniser: walks the whole text, tracking quote state, so commas/newlines inside quoted
// fields don't split rows. Unquoted fields are trimmed; quoted fields are preserved verbatim.
function tokenizeCSV(text: string): FieldInfo[][] {
  const rows: FieldInfo[][] = [];
  let row: FieldInfo[] = [];
  let current = '';
  let inQuotes = false;
  let wasQuoted = false;

  const pushField = (): void => { row.push({ value: wasQuoted ? current : current.trim(), wasQuoted }); current = ''; wasQuoted = false; };
  const pushRow = (): void => { pushField(); rows.push(row); row = []; };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { current += '"'; i++; continue; } // escaped quote ""
        inQuotes = false;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"') { wasQuoted = true; inQuotes = true; continue; }
    if (ch === ',') { pushField(); continue; }
    if (ch === '\r') continue; // swallow CR (CRLF)
    if (ch === '\n') { pushRow(); continue; }
    current += ch;
  }
  // Flush a trailing field/row when the text doesn't end in a newline.
  if (current !== '' || wasQuoted || row.length > 0) pushRow();
  return rows;
}
