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
import { detectFormatParser, ParseError } from './parsers.js';

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
      enum: ['pdf', 'ocr', 'docx', 'excel'],
      description: 'Parser format: pdf (extract text+tables), ocr (image→text), docx (extract structure), excel (sheet→JSON). Auto-detected from MIME type if omitted.',
    },
  },
};

const MAX_TEXT = 16000;

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
      'Read one Drive file as text by id with optional format parsing. Google Docs/Slides are exported to plain text and Google ' +
      'Sheets to CSV; plain-text files are downloaded directly. PDF, images (OCR), DOCX, and Excel files can be parsed with the ' +
      'format parameter (pdf, ocr, docx, excel); format is auto-detected from MIME type if omitted.',
    inputSchema: READ_SCHEMA,
    executor: {
      async *execute(input, ctx) {
        const args = (input ?? {}) as { file_id?: string; format?: string };
        const fileId = String(args.file_id ?? '').trim();
        if (!fileId) {
          yield { type: 'error', message: 'file_id is required' };
          return;
        }

        const client = new DriveClient(await accessToken(ctx, resolveShared));

        // First try standard text read (for Google Docs, text files, CSV).
        try {
          const { file, text } = await client.readFileText(fileId);
          const truncated = text.length > MAX_TEXT;
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
              content: truncated ? text.slice(0, MAX_TEXT) : text,
            },
          };
          return;
        } catch {
          // Fall through to format-based parsing below.
        }

        // Try format-based parsing (PDF, OCR, DOCX, Excel).
        const { file, bytes, mime } = await client.readFileBytes(fileId);
        const parser = detectFormatParser(mime, args.format);

        if (!parser) {
          yield {
            type: 'error',
            message: `unsupported file type: ${file.mimeType || 'unknown'} (try format=pdf|ocr|docx|excel)`,
          };
          return;
        }

        try {
          const parsed = await parser(bytes);
          const textContent =
            parsed.text.length > MAX_TEXT ? parsed.text.slice(0, MAX_TEXT) : parsed.text;
          const truncated = parsed.text.length > MAX_TEXT;

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
              content: textContent,
              tables: parsed.tables,
              sections: parsed.sections,
              metadata: parsed.metadata,
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
