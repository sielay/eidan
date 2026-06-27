// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent tools for the `gdrive` plugin — read the operator's Google Drive.
//
// Cross-plugin OAuth: the tools first ask the shared GoogleConnection service (registered by the
// `google`/Gmail plugin) for the connected account's vaulted client + refresh token, so a single
// connected Google account serves both once its consent grant includes the drive.readonly scope.
// When no account is connected they fall back to the legacy EIDAN_GOOGLE_* vault keys. Each call
// refreshes a short-lived access token from the resolved refresh token, then calls the Drive API.
// Read-only; nothing stored.
import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import { DriveClient } from './drive.js';
import { OAuthError, refreshAccessToken } from './oauth.js';
import { secretOpt } from './vault.js';
import { detectFormatParser, parseExcel, ParseError } from './parsers.js';
import { parseCSV } from './csv-parser.js';

const LIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max files (default 20).' },
  },
};
const SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1, description: 'Text matched against file name and full-text content.' },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max files (default 20).' },
  },
};
const READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['file_id'],
  properties: {
    file_id: { type: 'string', minLength: 1, description: 'Drive file id from gdrive_list_recent or gdrive_search.' },
    format: {
      type: 'string',
      enum: ['text', 'csv', 'table', 'pdf', 'ocr', 'docx', 'excel', 'excel_full'],
      description:
        'Output/parse format. "text" (default) returns raw content; "csv" returns an array of ' +
        '{col: val} objects and "table" returns {headers, rows} — both for Google Sheets/CSV. ' +
        '"pdf" (text+tables), "ocr" (image→text), "docx" (structure), "excel" (sheet summaries→JSON), ' +
        'and "excel_full" (all cell values→JSON, may exceed token limits) parse downloaded binary files; ' +
        'the binary format is auto-detected from the MIME type if omitted. ' +
        'NOTE: Text content is truncated to ~16k chars, but structured data (tables/sections) is preserved in full.',
    },
  },
};

// ponytail: MAX_TEXT is a simple limit to fit large documents into LLM context.
// For structured formats (PDF with tables, Excel, DOCX with sections), the text field
// is truncated but structured data (tables/sections) is always preserved. Agents receive
// a note if content is truncated but structured data remains. Consider smarter summarization
// or chunking for very large documents in future iterations.
const MAX_TEXT = 16000;
const TEXT_FORMATS = ['text', 'csv', 'table'];
const BINARY_FORMATS = ['pdf', 'ocr', 'docx', 'excel', 'excel_full'];

interface OAuthCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export type ResolveShared = (ctx: ToolContext) => Promise<OAuthCreds | null>;

interface DriveToolsDeps {
  resolveShared: ResolveShared;
}

// Resolve OAuth creds: the shared connected Google account first (from the GoogleConnection service
// the Gmail plugin registers), else the legacy EIDAN_GOOGLE_* vault keys, else throw. The refresh
// token is scope-agnostic — the same connected account works for Drive as long as drive.readonly
// was in the consent grant.
export async function accessToken(ctx: ToolContext, resolveShared: ResolveShared): Promise<string> {
  let creds = await resolveShared(ctx);
  if (!creds) {
    const clientId = await secretOpt(ctx, 'EIDAN_GOOGLE_CLIENT_ID');
    const clientSecret = await secretOpt(ctx, 'EIDAN_GOOGLE_CLIENT_SECRET');
    const refreshToken = await secretOpt(ctx, 'EIDAN_GOOGLE_REFRESH_TOKEN');
    if (clientId && clientSecret && refreshToken) {
      creds = { clientId, clientSecret, refreshToken };
    }
  }
  if (!creds) {
    throw new OAuthError(
      "Google isn't connected — add a Google account under Connections (Gmail), whose consent grant " +
        'includes the drive.readonly scope (one connected account serves both Gmail and Drive). As a ' +
        'fallback you may set EIDAN_GOOGLE_CLIENT_ID, EIDAN_GOOGLE_CLIENT_SECRET and ' +
        'EIDAN_GOOGLE_REFRESH_TOKEN (Settings → Connections).',
    );
  }
  try {
    return await refreshAccessToken(creds);
  } catch (exc) {
    throw new OAuthError(`Google token refresh failed: ${exc instanceof Error ? exc.message : String(exc)}`);
  }
}

export function makeDriveTools(deps: DriveToolsDeps): Tool[] {
  const { resolveShared } = deps;

  const gdriveListRecentTool: Tool = {
    name: 'gdrive_list_recent',
    description:
      'List the most recently modified files in the operator\'s Google Drive (id, name, type, ' +
      'modified time, owner, link). Folders and trashed files are excluded.',
    inputSchema: LIST_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { limit?: number };
        const client = new DriveClient(await accessToken(ctx, resolveShared));
        const files = await client.listRecent(Number(args.limit) || 20);
        yield { type: 'result', value: { files } };
      },
    },
  };

  const gdriveSearchTool: Tool = {
    name: 'gdrive_search',
    description:
      'Search the operator\'s Google Drive by name and full-text content, newest first. Returns ' +
      'file metadata (id, name, type, modified time, owner, link); read a hit with gdrive_read_file.',
    inputSchema: SEARCH_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { query?: string; limit?: number };
        const query = String(args.query ?? '').trim();
        if (!query) {
          yield { type: 'error', message: 'query is required' };
          return;
        }
        const client = new DriveClient(await accessToken(ctx, resolveShared));
        const files = await client.search(query, Number(args.limit) || 20);
        yield { type: 'result', value: { files } };
      },
    },
  };

  const gdriveReadFileTool: Tool = {
    name: 'gdrive_read_file',
    description:
      'Read one Drive file by id. Google Docs/Slides export to plain text and Google Sheets to CSV; ' +
      'plain-text files download directly. Pass format=csv|table to structure a Sheet/CSV, or ' +
      'format=pdf|ocr|docx|excel to parse a downloaded binary file (auto-detected from MIME if omitted).',
    inputSchema: READ_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { file_id?: string; format?: string };
        const fileId = String(args.file_id ?? '').trim();
        const format = String(args.format ?? 'text').toLowerCase();

        if (!fileId) {
          yield { type: 'error', message: 'file_id is required' };
          return;
        }
        if (![...TEXT_FORMATS, ...BINARY_FORMATS].includes(format)) {
          yield { type: 'error', message: `format must be one of ${[...TEXT_FORMATS, ...BINARY_FORMATS].join(', ')}` };
          return;
        }

        const wantBinary = BINARY_FORMATS.includes(format);
        const client = new DriveClient(await accessToken(ctx, resolveShared));

        // Text-first read (Google Docs/Slides → text, Sheets → CSV, plain text downloaded), unless a
        // document/binary parser was explicitly requested. A binary file that can't be read as text
        // falls through to MIME-auto-detected parsing below.
        let textRead: { file: Awaited<ReturnType<DriveClient['readFileText']>>['file']; text: string } | null = null;
        if (!wantBinary) {
          try {
            textRead = await client.readFileText(fileId);
          } catch {
            // not text-readable — fall through to binary parsing
          }
        }

        if (textRead) {
          const { file, text } = textRead;
          const meta = {
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            modifiedTime: file.modifiedTime,
            owner: file.owner,
            webViewLink: file.webViewLink,
          };

          // Default: raw text.
          if (format === 'text') {
            const truncated = text.length > MAX_TEXT;
            yield { type: 'result', value: { ...meta, truncated, content: truncated ? text.slice(0, MAX_TEXT) : text } };
            return;
          }

          // Structured CSV/table — only for CSV-exportable types; else return raw text with a note.
          const isCsvExportable =
            file.mimeType === 'application/vnd.google-apps.spreadsheet' ||
            file.mimeType === 'text/csv' ||
            file.mimeType === 'application/csv';
          if (!isCsvExportable) {
            const truncated = text.length > MAX_TEXT;
            yield {
              type: 'result',
              value: {
                ...meta,
                note: `format="${format}" only works with Google Sheets or CSV files; returning raw text instead`,
                content: truncated ? text.slice(0, MAX_TEXT) : text,
                truncated,
              },
            };
            return;
          }

          const parsed = parseCSV(text);
          if (format === 'csv') {
            yield { type: 'result', value: { ...meta, content: parsed.rows } };
          } else {
            yield { type: 'result', value: { ...meta, headers: parsed.headers, rows: parsed.rows } };
          }
          return;
        }

        // Document/binary parsing (PDF, OCR, DOCX, Excel) — explicit format, or text read failed.
        const { file, bytes, mime } = await client.readFileBytes(fileId);
        const parser = detectFormatParser(mime, wantBinary ? format : undefined);
        if (!parser) {
          yield {
            type: 'error',
            message: `unsupported file type: ${file.mimeType || mime || 'unknown'} (try format=pdf|ocr|docx|excel|excel_full)`,
          };
          return;
        }

        try {
          // Special handling for excel_full: pass fullText flag
          const parsed = format === 'excel_full' ? await parseExcel(bytes, true) : await parser(bytes);

          const truncated = parsed.text.length > MAX_TEXT;
          const hasStructuredContent = (parsed.tables?.length ?? 0) > 0 || (parsed.sections?.length ?? 0) > 0;
          const note = truncated && hasStructuredContent
            ? `Content exceeds ${MAX_TEXT} chars; text truncated but tables/sections preserved for full analysis.`
            : truncated && format === 'excel_full'
              ? `Excel full-text exceeds ${MAX_TEXT} chars. Review the tables field for all cell values.`
              : undefined;
          yield {
            type: 'result',
            value: {
              id: file.id,
              name: file.name,
              mimeType: file.mimeType,
              modifiedTime: file.modifiedTime,
              owner: file.owner,
              webViewLink: file.webViewLink,
              format: parsed.format,
              truncated,
              content: truncated ? parsed.text.slice(0, MAX_TEXT) : parsed.text,
              tables: parsed.tables,
              sections: parsed.sections,
              metadata: parsed.metadata,
              ...(note && { note }),
            },
          };
        } catch (exc) {
          if (exc instanceof ParseError) {
            yield { type: 'error', message: `parse error: ${exc.message}` };
          } else {
            yield { type: 'error', message: `parsing failed: ${exc instanceof Error ? exc.message : String(exc)}` };
          }
        }
      },
    },
  };

  return [gdriveListRecentTool, gdriveSearchTool, gdriveReadFileTool];
}
