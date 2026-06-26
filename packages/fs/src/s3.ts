// SPDX-License-Identifier: AGPL-3.0-or-later
// S3 (and S3-compatible: Cloudflare R2 / MinIO / Backblaze) storage backend for the fs virtual
// filesystem — same role as supabase.ts (offload large bytes out of the Postgres DB), with AWS SigV4
// request signing by hand (no SDK) over node:crypto. Path-style addressing so a custom endpoint just
// works. Config is resolved from the VAULT (see vault.ts) — never process.env directly.
//
// Vault config: EIDAN_S3_ACCESS_KEY_ID, EIDAN_S3_SECRET_ACCESS_KEY, EIDAN_S3_BUCKET, EIDAN_S3_REGION
// (default us-east-1), EIDAN_S3_ENDPOINT (default https://s3.<region>.amazonaws.com).
import { createHash, createHmac } from 'node:crypto';
import type { Resolve } from './vault.js';

export interface S3Cfg { accessKey: string; secretKey: string; region: string; bucket: string; endpoint: string }

export async function resolveS3Cfg(resolve: Resolve): Promise<S3Cfg | null> {
  const accessKey = await resolve('EIDAN_S3_ACCESS_KEY_ID');
  const secretKey = await resolve('EIDAN_S3_SECRET_ACCESS_KEY');
  const bucket = await resolve('EIDAN_S3_BUCKET');
  if (!accessKey || !secretKey || !bucket) return null;
  const region = (await resolve('EIDAN_S3_REGION')) || 'us-east-1';
  const endpoint = ((await resolve('EIDAN_S3_ENDPOINT')) || `https://s3.${region}.amazonaws.com`).replace(/\/+$/, '');
  return { accessKey, secretKey, region, bucket, endpoint };
}

function sha256hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}
function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}
function uriEncodeSegment(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
function encodeKey(key: string): string {
  return key.split('/').map(uriEncodeSegment).join('/');
}

interface Signed { url: string; headers: Record<string, string> }
function sign(cfg: S3Cfg, method: string, key: string, body?: Uint8Array, contentType?: string): Signed {
  const host = new URL(cfg.endpoint).host;
  const canonicalKey = encodeKey(key);
  const canonicalUri = `/${uriEncodeSegment(cfg.bucket)}/${canonicalKey}`;
  const url = `${cfg.endpoint}/${uriEncodeSegment(cfg.bucket)}/${canonicalKey}`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = body ? sha256hex(body) : sha256hex('');
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + cfg.secretKey, dateStamp), cfg.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  const headers: Record<string, string> = {
    authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };
  if (contentType && method === 'PUT') headers['content-type'] = contentType;
  return { url, headers };
}

export async function s3Upload(cfg: S3Cfg, key: string, bytes: Uint8Array, mime: string): Promise<void> {
  const { url, headers } = sign(cfg, 'PUT', key, bytes, mime || 'application/octet-stream');
  const r = await fetch(url, { method: 'PUT', headers, body: bytes as unknown as BodyInit, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`S3 upload failed (${r.status})`);
}

export async function s3Download(cfg: S3Cfg, key: string): Promise<Uint8Array> {
  const { url, headers } = sign(cfg, 'GET', key);
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`S3 download failed (${r.status})`);
  return new Uint8Array(await r.arrayBuffer());
}
