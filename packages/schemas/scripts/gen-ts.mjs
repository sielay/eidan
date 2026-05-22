#!/usr/bin/env node
// JSON Schema -> Zod codegen wrapper for @eidan/schemas.
//
// Walks schemas/**/*.schema.json, hands each tree to json-schema-to-zod,
// and writes one Zod module per schema under src/generated/, mirroring
// the source directory layout. Emits a barrel src/generated/index.ts
// that re-exports every generated module. The pipeline contract is
// pinned in docs/004_SCHEMAS.md §3.2 and §4.

import { readFile, readdir, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jsonSchemaToZod } from "json-schema-to-zod";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const schemasRoot = path.join(pkgRoot, "schemas");
const outRoot = path.join(pkgRoot, "src", "generated");

const HEADER = [
  "// AUTO-GENERATED — do not edit by hand.",
  "// Source: packages/schemas/schemas/**/*.schema.json",
  "// Run `pnpm --filter @eidan/schemas gen:ts` to refresh.",
  "",
].join("\n");

async function walk(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(abs)));
    } else if (entry.isFile() && entry.name.endsWith(".schema.json")) {
      out.push(abs);
    }
  }
  return out;
}

function relPosix(p) {
  return p.split(path.sep).join("/");
}

async function main() {
  const files = await walk(schemasRoot);
  files.sort();

  await rm(outRoot, { recursive: true, force: true });
  await mkdir(outRoot, { recursive: true });

  const barrelEntries = [];

  for (const absSchemaPath of files) {
    const rel = path.relative(schemasRoot, absSchemaPath);
    const parsed = JSON.parse(await readFile(absSchemaPath, "utf8"));
    const title = parsed.title;
    if (typeof title !== "string" || title.length === 0) {
      throw new Error(`schema ${rel} is missing a "title"`);
    }
    const expectedStem = title;
    const fileStem = path.basename(absSchemaPath, ".schema.json");
    if (fileStem !== expectedStem) {
      throw new Error(
        `schema ${rel} has title "${title}" but filename stem "${fileStem}"; they must agree (docs/004 §2.4)`,
      );
    }

    const body = jsonSchemaToZod(parsed, {
      name: title,
      module: "esm",
      type: true,
    });

    const dirRel = path.dirname(rel);
    const outDir = path.join(outRoot, dirRel);
    await mkdir(outDir, { recursive: true });

    const outPath = path.join(outDir, `${title}.ts`);
    await writeFile(outPath, HEADER + body + (body.endsWith("\n") ? "" : "\n"));

    const importPath = `./${relPosix(path.join(dirRel, title))}`;
    barrelEntries.push({ title, importPath });
  }

  barrelEntries.sort((a, b) => a.title.localeCompare(b.title));
  const barrel =
    HEADER +
    barrelEntries
      .map(
        (entry) => `export { ${entry.title} } from "${entry.importPath}";`,
      )
      .join("\n") +
    "\n";
  await writeFile(path.join(outRoot, "index.ts"), barrel);

  console.log(
    `[@eidan/schemas] gen:ts wrote ${barrelEntries.length} module(s) to ${relPosix(path.relative(pkgRoot, outRoot))}/`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
