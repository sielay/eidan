// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Rasterise the eidan glyph into the PNG sources @capacitor/assets needs, and
// refresh the PWA's raster icons (apps/web). Single source of truth for the
// mark lives here as SVG; run `node scripts/gen-icons.mjs` to regenerate.
//
// Uses the `sharp` that ships inside @capacitor/assets, so no extra dep and no
// system rasteriser (ImageMagick/rsvg) required.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// sharp is a dependency of @capacitor/assets, not a direct dep of ours, so pnpm
// doesn't hoist it. Resolve it through the assets package's own require context.
const requireFromAssets = createRequire(require.resolve("@capacitor/assets/package.json"));
const sharp = requireFromAssets("sharp");

const here = dirname(fileURLToPath(import.meta.url));
const mobile = resolve(here, "..");
const webIcons = resolve(mobile, "..", "web", "public", "icons");

const INDIGO = "#4F46E5";
const PAPER = "#FBFBFA";
const INK = "#16161A";

// The eidan glyph (4-point star), authored on a 512 viewBox. `full` is the
// home-screen-icon weight; `inset` is the maskable/safe-zone weight.
const glyph = (fill, weight) =>
  weight === "inset"
    ? `<g fill="${fill}">
         <path d="M256 168 Q271 238 256 344 Q241 238 256 168 Z"/>
         <path d="M168 256 Q238 271 344 256 Q238 241 168 256 Z"/>
         <path transform="rotate(45 256 256)" d="M256 188 Q269 240 256 324 Q243 240 256 188 Z"/>
         <path transform="rotate(45 256 256)" d="M188 256 Q240 269 324 256 Q240 243 188 256 Z"/>
       </g>`
    : `<g fill="${fill}">
         <path d="M256 120 Q277 235 256 392 Q235 235 256 120 Z"/>
         <path d="M120 256 Q235 277 392 256 Q235 235 120 256 Z"/>
         <path transform="rotate(45 256 256)" d="M256 150 Q272 240 256 362 Q240 240 256 150 Z"/>
         <path transform="rotate(45 256 256)" d="M150 256 Q240 272 362 256 Q240 243 150 256 Z"/>
       </g>`;

const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${body}</svg>`;

// A centred glyph at a given fraction of the canvas (for splash screens).
const centred = (bg, fg, frac) => {
  const s = 512 * frac;
  const o = (512 - s) / 2;
  return svg(
    `<rect width="512" height="512" fill="${bg}"/>` +
      `<g transform="translate(${o} ${o}) scale(${frac})">${glyph(fg, "full")}</g>`,
  );
};

const FULL = svg(`<rect width="512" height="512" fill="${INDIGO}"/>${glyph("#FFFFFF", "full")}`);
const ROUNDED = svg(
  `<rect width="512" height="512" rx="112" ry="112" fill="${INDIGO}"/>${glyph("#FFFFFF", "full")}`,
);
const MASKABLE = svg(`<rect width="512" height="512" fill="${INDIGO}"/>${glyph("#FFFFFF", "inset")}`);
const FOREGROUND = svg(glyph("#FFFFFF", "inset")); // transparent bg
const BACKGROUND = svg(`<rect width="512" height="512" fill="${INDIGO}"/>`);

const png = (markup, size) =>
  sharp(Buffer.from(markup)).resize(size, size).png().toBuffer();

async function out(path, markup, size) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, await png(markup, size));
  console.log("  ✓", path.replace(resolve(mobile, ".."), "apps"));
}

// @capacitor/assets sources (1024 icons, 2732 splashes).
const A = (p) => resolve(mobile, "assets", p);
// PWA raster icons consumed by apps/web/manifest.ts + apple-touch-icon.
const W = (p) => resolve(webIcons, p);

console.log("native (apps/mobile/assets):");
await out(A("icon.png"), FULL, 1024);
await out(A("icon-foreground.png"), FOREGROUND, 1024);
await out(A("icon-background.png"), BACKGROUND, 1024);
await out(A("splash.png"), centred(PAPER, INDIGO, 0.22), 2732);
await out(A("splash-dark.png"), centred(INK, "#FFFFFF", 0.22), 2732);

console.log("pwa (apps/web/public/icons):");
await out(W("icon-192.png"), ROUNDED, 192);
await out(W("icon-512.png"), ROUNDED, 512);
await out(W("icon-maskable-512.png"), MASKABLE, 512);
await out(W("apple-touch-icon.png"), FULL, 180);

console.log("done.");
