// SPDX-License-Identifier: AGPL-3.0-or-later
// Enforce AGPL-3.0-or-later headers on new source files in a PR.
//
// Run from the `License Header Check` workflow. Walks the set of files *added* in the PR (status `A`
// against the base sha), keeps only the extensions we care about, drops anything matched by the
// exempt-file globs, and prints the violators. Existing files without a header are not touched — the
// check is PR-scoped on additions so the policy rolls forward without flagging the pre-existing tree.
//
//   node .github/scripts/check-license-headers.mjs --base-sha <a> --head-sha <b> --exempt-file <path>
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';

// A file is compliant if either token appears in the first ~30 lines — covers the `//`/`*`/`#`
// SPDX comment forms plus handcrafted prose that mentions "AGPL-3.0-or-later".
const TOKENS = ['SPDX-License-Identifier: AGPL-3.0-or-later', 'AGPL-3.0-or-later'];
const TARGET_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const HEADER_LOOKAHEAD_LINES = 30;

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) {
    console.error(`[license] missing required ${name}`);
    process.exit(2);
  }
  return process.argv[i + 1];
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

function loadExempts(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map(globToRegExp);
}

function addedFiles(baseSha, headSha) {
  const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=A', `${baseSha}...${headSha}`], {
    encoding: 'utf8',
  });
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

function fileHasHeader(path) {
  let head;
  try {
    head = readFileSync(path, 'utf8').split('\n').slice(0, HEADER_LOOKAHEAD_LINES).join('\n');
  } catch {
    return false;
  }
  return TOKENS.some((t) => head.includes(t));
}

const baseSha = arg('--base-sha');
const headSha = arg('--head-sha');
const exempts = loadExempts(arg('--exempt-file'));
const added = addedFiles(baseSha, headSha);

const violators = [];
for (const rel of added) {
  if (!TARGET_EXTS.has(extname(rel))) continue;
  if (exempts.some((re) => re.test(rel))) continue;
  if (!existsSync(rel)) continue; // added then deleted in the same PR — nothing to check
  if (!fileHasHeader(rel)) violators.push(rel);
}

if (violators.length === 0) {
  console.log(`OK — no header violations across ${added.length} added file(s).`);
  process.exit(0);
}

console.error('The following NEW source files are missing the AGPL header:\n');
for (const v of violators) console.error(`  - ${v}`);
console.error(
  '\nAdd either an `SPDX-License-Identifier: AGPL-3.0-or-later` line or a prose AGPL header at the\n' +
    'top of each file. See CONTRIBUTING.md and .github/license_header_exempt.txt for the exempt list.',
);
process.exit(1);
