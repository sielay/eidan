// SPDX-License-Identifier: AGPL-3.0-or-later
// Supabase Storage backend for the fs virtual filesystem: keeps LARGE file bytes out of the Postgres
// blob table by storing them in a Supabase Storage bucket and recording only a reference
// (storage_kind='supabase', storage_ref=<object path>) in plugin_fs. Plain REST (no SDK). Config is
// resolved from the VAULT (see vault.ts) — never process.env directly.
//
// Vault config: EIDAN_SUPABASE_STORAGE_URL (https://<ref>.supabase.co), EIDAN_SUPABASE_STORAGE_KEY
// (a service-role key), EIDAN_SUPABASE_STORAGE_BUCKET (default 'eidan-files').
import type { Resolve } from './vault.js';

export interface SupabaseCfg { url: string; key: string; bucket: string }

export async function resolveSupabaseCfg(resolve: Resolve): Promise<SupabaseCfg | null> {
  const url = (await resolve('EIDAN_SUPABASE_STORAGE_URL'))?.replace(/\/+$/, '');
  const key = await resolve('EIDAN_SUPABASE_STORAGE_KEY');
  if (!url || !key) return null;
  const bucket = (await resolve('EIDAN_SUPABASE_STORAGE_BUCKET')) || 'eidan-files';
  return { url, key, bucket };
}

function objectUrl(cfg: SupabaseCfg, path: string): string {
  const enc = path.split('/').map(encodeURIComponent).join('/');
  return `${cfg.url}/storage/v1/object/${cfg.bucket}/${enc}`;
}

export async function supabaseUpload(cfg: SupabaseCfg, path: string, bytes: Uint8Array, mime: string): Promise<void> {
  const r = await fetch(objectUrl(cfg, path), {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.key}`, 'content-type': mime || 'application/octet-stream', 'x-upsert': 'true' },
    body: bytes as unknown as BodyInit,
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`Supabase Storage upload failed (${r.status})`);
}

export async function supabaseDownload(cfg: SupabaseCfg, path: string): Promise<Uint8Array> {
  const r = await fetch(objectUrl(cfg, path), {
    headers: { authorization: `Bearer ${cfg.key}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`Supabase Storage download failed (${r.status})`);
  return new Uint8Array(await r.arrayBuffer());
}
