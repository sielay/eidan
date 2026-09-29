<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0018 — Object storage on Cloudflare R2

Status: **Decided** — R2 is the object-storage provider behind `@eidandev/fs`. The S3-compatible
backend it drives is shipped; the public media bucket for documentation is not yet provisioned.

## Goal

Pick one object store for the two jobs eidan has: **private user bytes** (the fs virtual filesystem
offloads anything past 512 KB out of Postgres) and **public documentation media** (screencasts
embedded in the docs and the landing site). Record the choice, then give the operator runbooks so
provisioning, publishing, and rotation do not need re-deriving each time.

## Decision

**Cloudflare R2, not AWS S3, and not an unlisted YouTube channel.**

- **Egress decides it.** Video is egress-heavy and documentation video is pure egress. R2 charges
  nothing to serve bytes. S3 charges $0.09/GB served directly, so one popular clip turns into a
  bill you did not plan. Fronting S3 with CloudFront fixes the price and adds a distribution, an
  origin access control, and a cache-invalidation habit to maintain.
- **No new SDK.** R2 speaks the S3 API, so `packages/fs/src/s3.ts` signs for it unchanged — eidan
  hand-rolls SigV4 over `node:crypto` and carries no AWS dependency. Moving to real S3 later means
  changing one endpoint in the vault.
- **YouTube is not an option for product docs.** Google's terms let it serve ads on videos from
  non-monetised channels, unlisted ones included, so you cannot promise an ad-free page. The embed
  sets third-party cookies, which means a consent banner on a docs page aimed at schools. Unlisted
  is also not private: the URL is the only gate.
- **What eidan gives up.** No adaptive bitrate, no automatic transcoding, no per-video analytics.
  Documentation clips are short and low-traffic, so a single well-encoded MP4 behind a CDN covers
  it. Reach for Cloudflare Stream or Bunny Stream only once a video runs long enough that mobile
  viewers start buffering.

## Two buckets, two access models

| Bucket | Holds | Access | Served by |
|---|---|---|---|
| `eidan-files` | user uploads the fs offloads | **private** — no public URL | presigned GET, 15 min TTL |
| `eidan-docs-media` | documentation video, posters, screenshots | **public** | a Cloudflare custom domain |

Keep them separate. The private bucket must never gain a public domain, and the docs bucket must
never hold user bytes. Mixing them makes one misconfiguration a data leak.

## How it works

- **Config lives in the vault, not `.env`.** `resolveS3Cfg` reads every field through
  `vaultResolve(ctx.vault)`, so credentials are sealed at rest and editable in Settings →
  Connections → *File storage backends*. This follows [[0009-secrets-vault]].
- **Supabase Storage wins if both are set.** `makeFsWriter` resolves Supabase first and only falls
  through to S3 when it is absent (`const s3 = sup ? null : await resolveS3Cfg(resolve)`). To put
  bytes in R2, leave the three `EIDAN_SUPABASE_STORAGE_*` fields empty.
- **Offload threshold is 512 KB** (`OFFLOAD_BYTES`). Below it, bytes stay in Postgres `bytea` — see
  [[0015-storage-postgres]]. A Settings preference forces `always` or `never`.
- **Direct uploads bypass the engine.** `presign → browser PUT → finalize` lets a video-sized file
  go straight to R2, past Vercel's ~4.5 MB request cap. `finalize` HEADs the object to confirm the
  PUT landed and records the size. Object keys are `<principal-id>/<node-id>`.
- **Region stays unset.** R2's S3 API expects `auto`, and Cloudflare aliases both an empty value and
  `us-east-1` to it, so eidan's `us-east-1` default signs correctly with no extra config.

## Config

| Vault key | Value for R2 |
|---|---|
| `EIDAN_S3_ACCESS_KEY_ID` | R2 API token access key id |
| `EIDAN_S3_SECRET_ACCESS_KEY` | R2 API token secret access key |
| `EIDAN_S3_BUCKET` | `eidan-files` |
| `EIDAN_S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `EIDAN_S3_REGION` | leave unset |
| `EIDAN_FS_DIRECT_UPLOAD` | `1` to enable presigned browser uploads (needs CORS first) |

Account id, bucket domain, and token values are operator-private: they belong in the deploy repo's
`.env`, never here.

## Runbook — provision the buckets

```sh
npx wrangler r2 bucket create eidan-files
npx wrangler r2 bucket create eidan-docs-media
```

Mint credentials in the dashboard under **R2 → API → Create API token**: permission *Object Read &
Write*, scoped to those two buckets only. Record the access key id, the secret, and the account id,
then put them in Settings → Connections → *File storage backends*.

Verify the wiring by uploading a file over 512 KB through the fs UI and confirming the node reports
`storage_kind: s3`.

## Runbook — enable direct browser uploads

Presigned PUTs come from the app origin, so the bucket needs a CORS rule first. Read the current
rules before you replace them, because `cors set` overwrites.

```sh
npx wrangler r2 bucket cors list eidan-files
cat > /tmp/cors.json <<'JSON'
[{ "AllowedOrigins": ["https://<app-origin>"],
   "AllowedMethods": ["GET", "PUT", "HEAD"],
   "AllowedHeaders": ["*"],
   "ExposeHeaders": ["ETag"],
   "MaxAgeSeconds": 3600 }]
JSON
npx wrangler r2 bucket cors set eidan-files --file /tmp/cors.json
```

Then set `EIDAN_FS_DIRECT_UPLOAD=1`. Leave it off and the UI keeps using the server-side offload,
which is the safe default: `presign` refuses to mint a node it cannot upload to, so a CORS-blocked
PUT never orphans a `pending` row.

## Runbook — publish a documentation video

Give the docs bucket a public hostname once, then treat every object as immutable.

```sh
npx wrangler r2 bucket domain add eidan-docs-media --domain <media-domain> --zone-id <zone-id>
```

Encode, grab a poster frame, and upload with a versioned key:

```sh
ffmpeg -i raw.mov -vf scale=-2:1080 -c:v libx264 -crf 23 -preset slow \
  -c:a aac -b:a 128k -movflags +faststart fs-upload-v1.mp4
ffmpeg -ss 3 -i fs-upload-v1.mp4 -frames:v 1 -q:v 3 fs-upload-v1.jpg

npx wrangler r2 object put eidan-docs-media/videos/fs-upload-v1.mp4 --remote \
  --file fs-upload-v1.mp4 --content-type video/mp4 \
  --cache-control "public, max-age=31536000, immutable"
```

`-movflags +faststart` moves the index to the front so playback starts before the file finishes
downloading. Embed with the native player — no JS, no third-party requests:

```html
<video controls preload="metadata" width="960"
  poster="https://<media-domain>/videos/fs-upload-v1.jpg"
  src="https://<media-domain>/videos/fs-upload-v1.mp4"></video>
```

**Never overwrite an object in place.** The objects are cached for a year, so a re-record gets a new
key (`-v2`) and the docs page gets the new URL. Delete the old key after the docs deploy.

## Runbook — rotate the R2 token

1. Mint a second token with the same scope.
2. Update the four vault fields, then seal and deploy.
3. Confirm an upload and a playback still work.
4. Revoke the old token.

Presigned URLs signed with the old key stop working the moment you revoke it. Their TTL is 15
minutes, so rotate when nobody is mid-upload.

## Costs

| | Price | Free each month |
|---|---|---|
| Storage | $0.015/GB-month | 10 GB |
| Class A (writes) | $4.50/million | 1 million |
| Class B (reads) | $0.36/million | 10 million |
| Egress | $0 | unlimited |

Twenty 30 MB screencasts are 600 MB, inside the free tier. The bill only starts mattering once user
uploads pass 10 GB, and it never scales with viewers.

## Files of record

- `packages/fs/src/s3.ts` — SigV4 signing, upload/download/HEAD, presigned URLs, CORS read/write.
- `packages/fs/src/tools.ts` — backend selection, the 512 KB offload rule, `presign`/`finalize`.
- `packages/fs/src/vault.ts` — `OFFLOAD_BYTES` and vault resolution.
- `packages/fs/src/index.ts` — the Settings → Connections secret section.
- Related: [[0015-storage-postgres]] for what stays in Postgres, [[0009-secrets-vault]] for how
  these credentials are sealed.
