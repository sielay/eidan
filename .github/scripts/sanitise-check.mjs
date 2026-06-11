// SPDX-License-Identifier: AGPL-3.0-or-later
// Forbidden-string gate for repo sanitisation.
//
// Reads `release/forbidden-strings.txt`, walks the tracked tree, and exits non-zero if any literal
// or regex entry hits a tracked file. Runs in CI (`release-sanitisation.yml`). Files that are
// themselves *about* the forbidden list are allowlisted by path substring so the catalogue and its
// specs can mention items without self-tripping the gate.
//
// - Literal entries match by substring (the `rg -F` equivalent, no ripgrep dependency).
// - Regex entries are prefixed `re:`; the body compiles via the RegExp constructor.
// - A single hit is fatal — every hit is reported before exiting so the operator fixes in one pass.
//
//   node .github/scripts/sanitise-check.mjs [--catalogue <path>] [--root <dir>] [--dry-run]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';

const ALLOWLIST_SUBSTRINGS = [
  'release/forbidden-strings.txt',
  'release/env-example-forbidden-keys.txt',
  'docs/016_REPO_SANITISATION.md',
  'docs/018_DISTRIBUTION_AND_BUNDLES.md',
  '.github/scripts/sanitise-check.mjs',
  '.github/workflows/release-sanitisation.yml',
];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 || i + 1 >= process.argv.length ? fallback : process.argv[i + 1];
}
const dryRun = process.argv.includes('--dry-run');
const root = resolve(arg('--root', '.'));
const catalogue = arg('--catalogue', 'release/forbidden-strings.txt');

function loadEntries(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split('\n').map((l) => l.trim())) {
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('re:')) entries.push({ kind: 'regex', re: new RegExp(line.slice(3)), value: line.slice(3) });
    else entries.push({ kind: 'literal', value: line });
  }
  return entries;
}

function trackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

const entries = loadEntries(join(root, catalogue));
if (entries.length === 0) {
  console.log(`OK — catalogue at ${catalogue} has no entries; gate is open.`);
  process.exit(0);
}

const files = trackedFiles();
const violations = [];
for (const rel of files) {
  if (ALLOWLIST_SUBSTRINGS.some((s) => rel.includes(s))) continue;
  let text;
  try {
    text = readFileSync(join(root, rel), 'utf8');
  } catch {
    continue;
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const e of entries) {
      const hit = e.kind === 'literal' ? line.includes(e.value) : e.re.test(line);
      if (hit) violations.push({ rel, entry: e.value, lineNo: i + 1, excerpt: line.slice(0, 120) });
    }
  }
}

if (violations.length === 0) {
  console.log(`OK — scanned ${files.length} tracked file(s) against ${entries.length} forbidden entr(y/ies); no hits.`);
  process.exit(0);
}

console.error(`\n✗ Found ${violations.length} forbidden-string hit(s):\n`);
for (const v of violations) {
  console.error(`  ${v.rel}:${v.lineNo} — ${JSON.stringify(v.entry)}`);
  console.error(`      ${v.excerpt}`);
}
if (dryRun) {
  console.error('\n(--dry-run set; exiting 0 anyway so the operator can iterate locally.)');
  process.exit(0);
}
process.exit(1);
