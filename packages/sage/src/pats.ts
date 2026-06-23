// SPDX-License-Identifier: AGPL-3.0-or-later
// Port of eidan_gh.pats — load the PAT roster from EIDAN_GH_PATS and route one entry per
// (host, owner/repo, scope) by specificity. The Python loaded YAML or JSON; here we accept JSON
// (the canary topology injects a compact JSON list via extra_env). Tokens never reach argv — git.ts
// injects them via http.extraHeader env config and gh.ts via GH_TOKEN on the child only.

export interface PatEntry {
  host: string;
  target: string;
  scope: 'read' | 'write';
  token: string;
  label: string;
}

const VALID_SCOPES = new Set(['read', 'write']);

// Parse EIDAN_GH_PATS. Accepts either a bare JSON array of entries or a `{ "pats": [...] }` wrapper
// (mirrors the Python list-or-mapping shape). Empty / unset → []. Malformed → throws.
export function loadPats(raw: string | undefined, source = 'EIDAN_GH_PATS'): PatEntry[] {
  const text = (raw ?? '').trim();
  if (!text) return [];
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`could not parse PATs from ${source}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let entriesRaw: unknown[];
  if (Array.isArray(doc)) {
    entriesRaw = doc;
  } else if (doc && typeof doc === 'object') {
    const pats = (doc as Record<string, unknown>)['pats'];
    if (!Array.isArray(pats)) throw new Error(`PATs from ${source}: \`pats\` must be a list`);
    entriesRaw = pats;
  } else {
    throw new Error(`PATs from ${source} must be a list or mapping`);
  }
  return entriesRaw.map((e, i) => validateEntry(e, i, source));
}

function validateEntry(entry: unknown, idx: number, source: string): PatEntry {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`PATs from ${source}: entry [${idx}] must be a mapping`);
  }
  const e = entry as Record<string, unknown>;
  const token = typeof e['token'] === 'string' ? (e['token'] as string).trim() : '';
  if (!token) throw new Error(`PATs from ${source}: entry [${idx}] requires non-empty \`token\``);
  const host = (typeof e['host'] === 'string' && e['host'].trim()) || 'github.com';
  const target = (typeof e['target'] === 'string' && e['target'].trim()) || '*';
  const scope = (typeof e['scope'] === 'string' && e['scope'].trim()) || 'read';
  if (!VALID_SCOPES.has(scope)) {
    throw new Error(`PATs from ${source}: entry [${idx}] has invalid scope ${scope}`);
  }
  const label = (typeof e['label'] === 'string' && e['label'].trim()) || `pat-${idx + 1}`;
  return { host, target, scope: scope as 'read' | 'write', token, label };
}

// Pick the PAT for (host, owner/repo, scope) per docs/002 §3.4. write needs a write entry; read
// accepts either. Specificity rank: exact owner/repo (0) < owner-wide (1) < wildcard (2). Lowest
// rank wins, ties broken by roster order. Returns null when nothing matches.
export function routePat(
  entries: PatEntry[],
  opts: { host: string; ownerRepo: string; scope: 'read' | 'write' },
): PatEntry | null {
  const { host, ownerRepo, scope } = opts;
  if (ownerRepo.split('/').length !== 2) throw new Error(`expected owner/repo, got ${ownerRepo}`);
  const owner = ownerRepo.split('/', 1)[0]!;
  const rank = (e: PatEntry): number => {
    if (e.target === ownerRepo) return 0;
    if (e.target === owner || e.target === `${owner}/*`) return 1;
    if (e.target === '*') return 2;
    return 3;
  };
  const ranked = entries
    .map((e, idx) => ({ e, idx, r: rank(e) }))
    .filter(({ e, r }) => e.host === host && r < 3 && (scope === 'write' ? e.scope === 'write' : true))
    .sort((a, b) => a.r - b.r || a.idx - b.idx);
  return ranked.length ? ranked[0]!.e : null;
}
