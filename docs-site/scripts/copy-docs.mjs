// Sync the repo's docs/ and ROADMAP.md into Starlight's content tree.
// Runs before `astro dev` / `astro build` (see package.json scripts).
// The copy targets are gitignored (see docs-site/.gitignore) — the
// canonical source remains the repo-root markdown.

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SRC_DOCS = join(ROOT, "docs");
const DEST = join(HERE, "..", "src", "content", "docs");
const SPECS = join(DEST, "specs");

// docs/*.md filenames in the Operate sidebar group are flattened to the
// docs root with lowercase slugs (architecture, deployment, localhost).
// Anything not in this map lands under specs/.
const NAMED = {
  "ARCHITECTURE.md": "architecture.md",
  "DEPLOYMENT.md": "deployment.md",
  "LOCALHOST.md": "localhost.md",
};

function deriveTitle(filename, body) {
  const headingMatch = body.match(/^#\s+(.+)$/m);
  if (headingMatch) return headingMatch[1].trim();
  return filename.replace(/\.md$/i, "");
}

function withFrontmatter(body, title) {
  if (body.startsWith("---\n")) return body;
  const safeTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `---\ntitle: "${safeTitle}"\n---\n\n${body}`;
}

async function reset() {
  await rm(SPECS, { recursive: true, force: true });
  for (const namedTarget of Object.values(NAMED)) {
    await rm(join(DEST, namedTarget), { force: true });
  }
  await rm(join(DEST, "roadmap.md"), { force: true });
  await mkdir(SPECS, { recursive: true });
}

async function copyDir(srcDir, namedMap) {
  const files = await readdir(srcDir);
  for (const filename of files) {
    if (!filename.endsWith(".md")) continue;
    const body = await readFile(join(srcDir, filename), "utf8");
    const title = deriveTitle(filename, body);
    const rendered = withFrontmatter(body, title);
    const target =
      namedMap[filename] ?? join("specs", filename.toLowerCase());
    await writeFile(join(DEST, target), rendered);
  }
}

async function copyRoadmap() {
  try {
    const body = await readFile(join(ROOT, "ROADMAP.md"), "utf8");
    await writeFile(
      join(DEST, "roadmap.md"),
      withFrontmatter(body, "Roadmap"),
    );
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

await reset();
await copyDir(SRC_DOCS, NAMED);
await copyRoadmap();
console.log("docs-site: synced ../docs and ../ROADMAP.md");
