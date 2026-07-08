// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices, ToolContext } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { FsDb } from './db.js';
import { buildFsTools, makeFsReader, makeFsWriter, makeFsPresigner, type GoogleDriveSvc, type FsReader, type FsWriter, type FsPresigner } from './tools.js';

// Consume the gdrive plugin's GoogleDrive service (matbot registry idiom; no hard dep) so a Drive
// file can be linked into the fs as a live reference. Absent when gdrive isn't loaded.
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    GoogleDrive?: GoogleDriveSvc;
  }
}

// Expose a reader other plugins / the web-serving route use to fetch any fs file's bytes regardless of
// backend (local pg / Supabase Storage / S3 / Drive). The engine route /api/fs/blob calls this so the
// web never needs storage creds.
interface EidanFs {
  readBytes(ctx: ToolContext, nodeId: string): Promise<{ name: string; mime: string; bytes: Uint8Array } | null>;
  upload: FsWriter;
  presignUpload: FsPresigner['presign'];
  finalizeUpload: FsPresigner['finalize'];
  downloadUrl: FsPresigner['downloadUrl'];
}
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    EidanFs?: EidanFs;
  }
}

// Optional integration with the eidan secrets catalog: declare the storage-backend config so Settings
// → Connections renders a secure section (config lives in the VAULT, not .env). Structurally
// re-declared (matbot idiom) so the bundle needs no hard dep on core.
interface SecretField { name: string; label: string; secret?: boolean; required?: boolean; help?: string }
interface SecretSection { plugin: string; title: string; fields: SecretField[] }
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    EidanSecrets?: { declareSection(section: SecretSection): void };
  }
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'Eidan virtual filesystem: file browser, folder organization, DB-backed local storage, large-file offload to Supabase Storage / S3, and Google Drive references — one tree, any backend.',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) throw new Error('EIDAN_DATABASE_URL (or DATABASE_URL) must be set for @eidandev/fs');
    const db = new FsDb(url);
    await db.ensureSchema();
    const getDrive = (): GoogleDriveSvc | undefined => services.GoogleDrive;
    for (const tool of buildFsTools(db, getDrive)) services.tools.register(tool);

    const reader: FsReader = makeFsReader(db, getDrive);
    const writer: FsWriter = makeFsWriter(db);
    const presigner: FsPresigner = makeFsPresigner(db);
    await services.register('EidanFs', {
      readBytes: reader,
      upload: writer,
      presignUpload: presigner.presign,
      finalizeUpload: presigner.finalize,
      downloadUrl: presigner.downloadUrl,
    });

    // Storage-backend config — sealed in the vault, surfaced in Settings → Connections.
    services.EidanSecrets?.declareSection({
      plugin: 'fs',
      title: 'File storage backends',
      fields: [
        { name: 'EIDAN_SUPABASE_STORAGE_URL', label: 'Supabase Storage URL', help: 'e.g. https://<project-ref>.supabase.co — large files offload here instead of the DB.' },
        { name: 'EIDAN_SUPABASE_STORAGE_KEY', label: 'Supabase service-role key', secret: true },
        { name: 'EIDAN_SUPABASE_STORAGE_BUCKET', label: 'Supabase bucket', help: 'Default "eidan-files". Create it in Supabase → Storage.' },
        { name: 'EIDAN_S3_ACCESS_KEY_ID', label: 'S3 access key id', help: 'Alternative to Supabase. Works with AWS S3 and S3-compatible (R2/MinIO/Backblaze).' },
        { name: 'EIDAN_S3_SECRET_ACCESS_KEY', label: 'S3 secret access key', secret: true },
        { name: 'EIDAN_S3_BUCKET', label: 'S3 bucket' },
        { name: 'EIDAN_S3_REGION', label: 'S3 region', help: 'Default us-east-1.' },
        { name: 'EIDAN_S3_ENDPOINT', label: 'S3 endpoint', help: 'Only for S3-compatible providers, e.g. https://<account>.r2.cloudflarestorage.com. Omit for AWS.' },
      ],
    });
    console.log('[fs] registered fs tools + EidanFs reader');
  },
};
