<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# eidan docs (`docs-site/`)

The eidan documentation site, built with [Docusaurus](https://docusaurus.io/). Deploys to
**docs.eidan.dev**. It is **not** a pnpm-workspace member — it manages its own install (npm), so it
never touches the root `pnpm-lock.yaml`.

## Local

```bash
cd docs-site
npm install
npm start          # dev server at http://localhost:3000
npm run build      # static build → ./build
```

## How it's organised

- `docs/` — the content (Markdown/MDX). Docs are served at the **site root** (`routeBasePath: '/'`),
  so `docs/intro.md` (`slug: /`) is the home page.
- `sidebars.ts` — the sidebar/IA. Only pages that exist are listed.
- `docusaurus.config.ts` — site config. Search is fully local/offline
  (`@easyops-cn/docusaurus-search-local`) so it works on GitHub Pages **and** Vercel with no external
  service.
- `src/css/custom.css` — the indigo theme (matches the product).

## The rule that keeps docs from rotting

**A feature ships with its doc page in the same PR.** When you add or change a capability in
`packages/<name>`, add/update its page here and list it in `sidebars.ts`. Planned sections still to
land: Guides, Bundles, Reference (ideally generated from `packages/*` + `/api/plugins`), and the
Developer guide.

## Authoring notes

- Only document **shipped** features — no roadmap items dressed as present-tense.
- `.ts`/`.tsx`/`.js` files need the SPDX AGPL header (CI enforces it); `.md`/`.json`/`.css` do not.
- The `/use-cases` page is curated from **real** sessions — no fabricated community quotes.
