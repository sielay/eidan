// SPDX-License-Identifier: AGPL-3.0-or-later
// Google Drive v3 read client for the eidan `gdrive` plugin. Lists/searches files and reads
// their contents via the Drive REST API with a short-lived access token. Google-native docs
// (Docs/Sheets/Slides) are exported to text via files.export; ordinary files are downloaded via
// files.get?alt=media. Read-only; nothing stored.
const DRIVE_API = 'https://www.googleapis.com/drive/v3';

export class DriveError extends Error {}

// Fields requested for every file listing — kept narrow (read-through, no storage).
const FILE_FIELDS = 'id,name,mimeType,modifiedTime,size,owners(displayName,emailAddress),webViewLink';
const LIST_FIELDS = `files(${FILE_FIELDS})`;

// Google-native MIME types and the export target we ask Drive for. Docs/Slides → plain text;
// Sheets → CSV (the only tabular text export Drive offers). Anything not listed is downloaded raw.
const GOOGLE_NATIVE_EXPORTS: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

// Raw (non-native) MIME types we are willing to read as text. Everything else (images, PDFs,
// binaries) is reported as unsupported rather than dumping bytes into the model context.
const TEXTUAL_PREFIXES = ['text/'];
const TEXTUAL_EXACT = new Set([
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/javascript',
  'application/csv',
]);

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string | null;
  size: number | null;
  owner: string | null;
  webViewLink: string | null;
}

interface RawFile {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  size?: string;
  owners?: { displayName?: string; emailAddress?: string }[];
  webViewLink?: string;
}

// --- Pure helpers (unit-tested) -------------------------------------------------------------

export function normalizeFile(raw: RawFile): DriveFile {
  const owner = raw.owners && raw.owners.length > 0 ? raw.owners[0] : undefined;
  let size: number | null = null;
  if (typeof raw.size === 'string' && raw.size !== '') {
    const n = Number(raw.size);
    size = Number.isFinite(n) ? n : null;
  }
  return {
    id: raw.id ?? '',
    name: raw.name ?? '',
    mimeType: raw.mimeType ?? '',
    modifiedTime: raw.modifiedTime ?? null,
    size,
    owner: owner ? (owner.displayName ?? owner.emailAddress ?? null) : null,
    webViewLink: raw.webViewLink ?? null,
  };
}

export function isGoogleNative(mimeType: string): boolean {
  return mimeType in GOOGLE_NATIVE_EXPORTS;
}

// Returns the export MIME type for a Google-native file, or null if it is not natively exportable.
export function exportMimeFor(mimeType: string): string | null {
  return GOOGLE_NATIVE_EXPORTS[mimeType] ?? null;
}

export function isTextualMime(mimeType: string): boolean {
  const base = mimeType.split(';', 1)[0]!.trim().toLowerCase();
  if (TEXTUAL_EXACT.has(base)) return true;
  return TEXTUAL_PREFIXES.some((p) => base.startsWith(p));
}

// Build a Drive `q` for the recent/search listings. Folders and trashed files are excluded; a
// caller-supplied free-text term is matched against name and full-text content.
export function buildSearchQuery(term?: string): string {
  const clauses = ['trashed = false', "mimeType != 'application/vnd.google-apps.folder'"];
  const t = (term ?? '').trim();
  if (t) {
    const esc = t.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    clauses.push(`(name contains '${esc}' or fullText contains '${esc}')`);
  }
  return clauses.join(' and ');
}

// --- Network client -------------------------------------------------------------------------

export class DriveClient {
  private readonly token: string;

  constructor(accessToken: string) {
    this.token = accessToken;
  }

  private async request(url: string): Promise<Response> {
    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (exc) {
      throw new DriveError(`Drive request failed: ${exc instanceof Error ? exc.message : String(exc)}`);
    }
    if (resp.status === 401) throw new DriveError('Drive rejected the access token');
    if (resp.status === 404) throw new DriveError('file not found (or no access)');
    if (resp.status !== 200) throw new DriveError(`Drive API returned HTTP ${resp.status}`);
    return resp;
  }

  private async json(url: string): Promise<Record<string, unknown>> {
    const resp = await this.request(url);
    return (await resp.json()) as Record<string, unknown>;
  }

  private async list(q: string, limit: number, orderBy?: string): Promise<DriveFile[]> {
    const params = new URLSearchParams({
      q,
      pageSize: String(limit),
      fields: LIST_FIELDS,
      spaces: 'drive',
    });
    if (orderBy) params.set('orderBy', orderBy);
    const data = await this.json(`${DRIVE_API}/files?${params.toString()}`);
    const raw = (data['files'] as RawFile[] | undefined) ?? [];
    return raw.map(normalizeFile);
  }

  async listRecent(limit: number): Promise<DriveFile[]> {
    return this.list(buildSearchQuery(), limit, 'modifiedTime desc');
  }

  async search(term: string, limit: number): Promise<DriveFile[]> {
    return this.list(buildSearchQuery(term), limit, 'modifiedTime desc');
  }

  async getMeta(fileId: string): Promise<DriveFile> {
    const params = new URLSearchParams({ fields: FILE_FIELDS });
    const data = await this.json(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params.toString()}`);
    return normalizeFile(data as RawFile);
  }

  // List the direct children of a folder (subfolders + files), folders first — for mounting a Drive
  // folder into the virtual fs and browsing it. `folderId` 'root' (or empty) lists the Drive root.
  async listChildren(folderId: string, limit = 200): Promise<DriveFile[]> {
    const id = !folderId || folderId === 'root' ? 'root' : folderId;
    const q = `'${id.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' in parents and trashed = false`;
    return this.list(q, limit, 'folder,name');
  }

  // Download a file's raw bytes + effective mime. Google-native docs are exported (Docs/Slides→text,
  // Sheets→CSV); everything else is downloaded as-is via alt=media (so images/PDFs come back intact).
  async readFileBytes(fileId: string): Promise<{ file: DriveFile; bytes: Uint8Array; mime: string }> {
    const file = await this.getMeta(fileId);
    let url: string;
    let mime = file.mimeType;
    if (isGoogleNative(file.mimeType)) {
      const exportMime = exportMimeFor(file.mimeType) ?? 'text/plain';
      mime = exportMime;
      url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?${new URLSearchParams({ mimeType: exportMime }).toString()}`;
    } else {
      url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`;
    }
    const resp = await this.request(url);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    return { file, bytes, mime };
  }

  // Read a file's content as text. Google-native files are exported to text/CSV; ordinary textual
  // files are downloaded via alt=media. Binary/unsupported types throw rather than returning bytes.
  async readFileText(fileId: string): Promise<{ file: DriveFile; text: string }> {
    const file = await this.getMeta(fileId);
    let url: string;
    if (isGoogleNative(file.mimeType)) {
      const exportMime = exportMimeFor(file.mimeType)!;
      const params = new URLSearchParams({ mimeType: exportMime });
      url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?${params.toString()}`;
    } else if (isTextualMime(file.mimeType)) {
      url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`;
    } else {
      throw new DriveError(
        `cannot read '${file.name}' as text: unsupported type ${file.mimeType || 'unknown'} ` +
          '(only Google Docs/Sheets/Slides and plain-text files are supported)',
      );
    }
    const resp = await this.request(url);
    const text = await resp.text();
    return { file, text };
  }
}
