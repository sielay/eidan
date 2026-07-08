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

// HEAD an object: confirm it exists after a direct (presigned) upload and read its size. Returns null
// when the object isn't there (404, or 403 on a bucket without ListBucket for a missing key).
export async function s3Head(cfg: S3Cfg, key: string): Promise<{ size: number } | null> {
  const { url, headers } = sign(cfg, 'HEAD', key);
  const r = await fetch(url, { method: 'HEAD', headers, signal: AbortSignal.timeout(30_000) });
  if (r.status === 404 || r.status === 403) return null;
  if (!r.ok) throw new Error(`S3 head failed (${r.status})`);
  const len = r.headers.get('content-length');
  return { size: len ? parseInt(len, 10) : 0 };
}

// Presigned URL (SigV4 in the query string) so a BROWSER can PUT (upload) or GET (download) the object
// DIRECTLY against S3 — bypassing the engine + Vercel's ~4.5MB body cap, which is what makes video-
// sized uploads possible. Only `host` is signed, so the client may send any content-type. Default TTL
// 15 min. The bucket must allow the app origin in its CORS policy for a browser PUT to succeed.
export function s3PresignUrl(cfg: S3Cfg, method: 'PUT' | 'GET', key: string, expiresSec = 900): string {
  const host = new URL(cfg.endpoint).host;
  const canonicalKey = encodeKey(key);
  const canonicalUri = `/${uriEncodeSegment(cfg.bucket)}/${canonicalKey}`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const params: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${cfg.accessKey}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresSec),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(params).sort()
    .map((k) => `${uriEncodeSegment(k)}=${uriEncodeSegment(params[k] as string)}`).join('&');
  const canonicalHeaders = `host:${host}\n`;
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + cfg.secretKey, dateStamp), cfg.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return `${cfg.endpoint}/${uriEncodeSegment(cfg.bucket)}/${canonicalKey}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// PutBucketCors — allow a browser origin to PUT/GET directly (needed for presigned uploads from the
// app). Applied only when the operator opts in; overwrites the bucket's CORS rules, so read first.
export async function s3GetCors(cfg: S3Cfg): Promise<string | null> {
  const { url, headers } = signQuery(cfg, 'GET', 'cors');
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (r.status === 404) return null; // NoSuchCORSConfiguration
  if (!r.ok) throw new Error(`S3 get-cors failed (${r.status})`);
  return await r.text();
}

// Sign a bucket sub-resource request (e.g. ?cors) with SigV4 headers. Like sign() but the canonical
// URI is the bucket root and the sub-resource is the only query param (part of the signature).
function signQuery(cfg: S3Cfg, method: string, subresource: string, body?: Uint8Array, contentType?: string): { url: string; headers: Record<string, string> } {
  const host = new URL(cfg.endpoint).host;
  const canonicalUri = `/${uriEncodeSegment(cfg.bucket)}/`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = body ? sha256hex(body) : sha256hex('');
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalQuery = `${uriEncodeSegment(subresource)}=`;
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + cfg.secretKey, dateStamp), cfg.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  const headers: Record<string, string> = {
    authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };
  if (contentType) headers['content-type'] = contentType;
  return { url: `${cfg.endpoint}/${uriEncodeSegment(cfg.bucket)}/?${subresource}`, headers };
}

export async function s3PutCors(cfg: S3Cfg, xml: string): Promise<void> {
  const body = new TextEncoder().encode(xml);
  const md5 = createHash('md5').update(body).digest('base64');
  const { url, headers } = signQuery(cfg, 'PUT', 'cors', body, 'application/xml');
  headers['content-md5'] = md5; // S3 requires Content-MD5 on PutBucketCors
  const r = await fetch(url, { method: 'PUT', headers, body: body as unknown as BodyInit, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`S3 put-cors failed (${r.status}): ${await r.text()}`);
}
