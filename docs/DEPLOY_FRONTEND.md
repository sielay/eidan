# Frontend (Vercel)

The Next.js app at `apps/web` is a stock App Router project. The
deploy CLI doesn't touch Vercel; this is the standard click-through.

## Setup

1. Vercel dashboard → **New project** → import this repo, root
   `apps/web`.
2. **Framework preset**: Next.js. **Build command**:
   `pnpm --filter @eidan/web build`. **Install command**:
   `pnpm install --frozen-lockfile`. **Output directory**:
   `apps/web/.next` (default).
3. **Environment variables**:
   - `NEXT_PUBLIC_EIDAN_BACKEND_URL=https://api.yourdomain.com` (or
     wherever the recipe's backend lives). The backend host MUST
     share its registrable domain with the frontend host configured
     in step 4 — see
     [DEPLOY_FLY_BOOTSTRAP §3](./DEPLOY_FLY_BOOTSTRAP.md#3-custom-domain-load-bearing).
     Pointing at `eidan-api.fly.dev` while the frontend is on
     `app.yourdomain.com` will silently break the refresh cookie.
4. Deploy. Set the production domain to `app.yourdomain.com` under
   **Settings → Domains**.
5. Smoke-check: visit `https://app.yourdomain.com`, click sign-in.
   The magic link arrives by email; the verify round-trip should
   land you on the conversation list.

The frontend talks directly to the native auth endpoints
(`/api/auth/magic-link`, `/api/auth/verify`, `/api/auth/refresh`).
No third-party SDK in the bundle.

## Alternative hosts

Fly machine (Node runtime) and Heroku web dyno both work. Same
trade-offs apply — you give up Vercel's edge cache and
preview-per-branch for a single billing surface. Vercel is the
default unless you have a specific reason to consolidate.
