// SPDX-License-Identifier: AGPL-3.0-or-later
// Throwaway runtime smoke for the pure logic — verifies the module graph loads and the parsers /
// routers / predicates behave. No DB, no network, no subprocess. Run: pnpm dlx tsx smoke.test.mts
import assert from 'node:assert/strict';
import { parseRepo, extractOpenQuestions } from './src/pipeline.ts';
import { loadPats, routePat } from './src/pats.ts';
import { parseVerdicts, COPILOT_VERDICTS, CI_VERDICTS } from './src/triage.ts';
import { parseConcerns } from './src/critic.ts';
import { verdictFor, blockingConcerns } from './src/selfreview.ts';
import { copilotSubmitted, copilotPending, failingChecks, openThreads, shouldTerminate } from './src/iteration.ts';
import { resolvePonytail } from './src/config.ts';

let n = 0;
const ok = (name: string): void => { n += 1; console.log(`  ✓ ${name}`); };

// parseRepo
assert.deepEqual(parseRepo('sielay/eidan'), { host: 'github.com', owner: 'sielay', repo: 'eidan' });
assert.deepEqual(parseRepo('ghe.acme.com:org/proj'), { host: 'ghe.acme.com', owner: 'org', repo: 'proj' });
ok('parseRepo handles owner/repo and host:owner/repo');

// extractOpenQuestions
assert.equal(extractOpenQuestions('did work\n\n## Open questions\n- should X be Y?'), '- should X be Y?');
assert.equal(extractOpenQuestions('did work\n\n## Open questions\nNone.'), '');
assert.equal(extractOpenQuestions('no section here'), '');
ok('extractOpenQuestions pulls the section, treats None/absent as empty');

// PAT routing — specificity: exact > owner-wide > wildcard
const pats = loadPats(JSON.stringify([
  { host: 'github.com', target: '*', scope: 'read', token: 'WILD' },
  { host: 'github.com', target: 'sielay', scope: 'write', token: 'OWNER' },
  { host: 'github.com', target: 'sielay/eidan', scope: 'write', token: 'EXACT' },
]));
assert.equal(routePat(pats, { host: 'github.com', ownerRepo: 'sielay/eidan', scope: 'write' })?.token, 'EXACT');
assert.equal(routePat(pats, { host: 'github.com', ownerRepo: 'sielay/other', scope: 'write' })?.token, 'OWNER');
assert.equal(routePat(pats, { host: 'github.com', ownerRepo: 'someone/else', scope: 'read' })?.token, 'WILD');
assert.equal(routePat(pats, { host: 'github.com', ownerRepo: 'someone/else', scope: 'write' }), null); // wild is read-only
ok('routePat ranks exact > owner > wildcard and honours scope');

// triage verdict parsing — fenced block, strict on shape, lenient on rows
const triageOut = '```json\n[{"thread_id":"T1","verdict":"fix","reason":"r","fix_hint":"do x"},{"thread_id":"","verdict":"fix"},{"thread_id":"T2","verdict":"bogus"}]\n```';
const verdicts = parseVerdicts(triageOut, 'thread_id', COPILOT_VERDICTS);
assert.equal(verdicts.length, 1); // empty ref + bad verdict dropped
assert.equal(verdicts[0]!.ref, 'T1');
assert.equal(verdicts[0]!.fixHint, 'do x');
assert.deepEqual(parseVerdicts('```json\n[]\n```', 'check', CI_VERDICTS), []); // empty is valid
ok('parseVerdicts: fenced JSON, drops bad rows, empty array valid');

// critic / self-review concern parsing + verdict
const concerns = parseConcerns('```json\n[{"severity":"error","message":"bug","file":"a.ts","line":3},{"severity":"note","message":"nit"},{"severity":"???","message":"x"}]\n```');
assert.equal(concerns.length, 2); // bad severity dropped
assert.equal(verdictFor(concerns), 'request_changes'); // has an error
assert.equal(blockingConcerns(concerns).length, 1);
assert.equal(verdictFor([{ severity: 'note', kind: null, file: null, line: null, message: 'n', suggestedFix: null }]), 'approve');
ok('parseConcerns + verdictFor: error/warning block, note approves');

// loop predicates
assert.equal(copilotSubmitted([{ author: { login: 'copilot-pull-request-reviewer[bot]' }, state: 'COMMENTED' }]), true);
assert.equal(copilotSubmitted([{ author: { login: 'copilot-pull-request-reviewer[bot]' }, state: 'PENDING' }]), false);
assert.equal(copilotSubmitted([{ author: { login: 'human' }, state: 'APPROVED' }]), false);
assert.equal(copilotPending([{ login: 'Copilot' }]), true);
assert.equal(failingChecks([{ name: 'ci', state: 'failure' }, { name: 'ok', state: 'success' }]).length, 1);
assert.equal(failingChecks([{ name: 'ci', bucket: 'fail' }]).length, 1);
assert.equal(openThreads([{ id: '1', is_resolved: false, is_outdated: false, path: null, comments: [] }, { id: '2', is_resolved: true, is_outdated: false, path: null, comments: [] }]).length, 1);
assert.equal(shouldTerminate([], []), true);
assert.equal(shouldTerminate([{ id: '1', is_resolved: false, is_outdated: false, path: null, comments: [] }], []), false);
ok('loop predicates: copilotSubmitted/pending, failingChecks, openThreads, shouldTerminate');

// ponytail config gate: default full + vendored dir resolves; off disables; case-insensitive; unknown→full
{
  const save = process.env['EIDAN_SAGE_PONYTAIL'];
  const set = (v?: string): void => { if (v === undefined) delete process.env['EIDAN_SAGE_PONYTAIL']; else process.env['EIDAN_SAGE_PONYTAIL'] = v; };
  set(undefined);
  let p = resolvePonytail();
  assert.equal(p.mode, 'full');           // default on
  assert.ok(p.dir && p.dir.endsWith('vendor/ponytail')); // vendored dir resolves relative to src/
  assert.ok(p.system && p.system.includes('YAGNI') && p.system.includes('level: full')); // ruleset for --append-system-prompt
  set('off'); p = resolvePonytail();
  assert.equal(p.dir, null); assert.equal(p.mode, undefined); assert.equal(p.system, undefined); // fully disabled
  set('LITE'); p = resolvePonytail();
  assert.equal(p.mode, 'lite'); assert.ok(p.system!.includes('level: lite')); // case-insensitive, mode in ruleset
  set('bogus'); p = resolvePonytail();
  assert.equal(p.mode, 'full');           // unrecognised falls back to full
  set(save);
  ok('resolvePonytail: default full + ruleset system text, off disables, case-insensitive, unknown→full');
}

console.log(`\nAll ${n} smoke groups passed.`);
