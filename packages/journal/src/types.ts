// SPDX-License-Identifier: AGPL-3.0-or-later
// Journal taxonomy + pure helpers (no DB, so they unit-test standalone). The "specific way of
// logging": every dropped note becomes one or more structured entries with an EntryType. The
// EntryType is what routing keys off — only bug/task can open a code job; everything else is a log
// the planning agents read.

export const ENTRY_TYPES = ['devlog', 'bug', 'idea', 'content_seed', 'task'] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

// Which entry types are candidates for a sage code job. A bug you hit or a concrete task you want
// done → delegate; a devlog/idea/content_seed is just recorded (and later mined for content).
const CODE_JOB_TYPES = new Set<EntryType>(['bug', 'task']);

export interface JournalEntry {
  id: string;
  user_id: string;
  project: string | null;
  entry_type: EntryType;
  summary: string;
  body: string | null;
  source: string | null;
  target_repo: string | null;
  metadata: Record<string, unknown>;
  job_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface JournalSettings {
  user_id: string;
  direction_prompt: string;
  updated_at: Date;
}

// The out-of-the-box direction prompt. Editable per user via the `journal_direction` tool; this is
// only the seed, so the operator can rewrite the whole routing policy in their own words.
export const DEFAULT_DIRECTION_PROMPT = [
  'You maintain the operator\'s work journal. When they drop a note (text or transcribed voice) about',
  'what they built, tested, noticed, or want, split it into distinct items and record each with',
  'journal_capture. For every item decide:',
  '',
  '- project: which thing it concerns (e.g. "eidan", "mathgame", "adaptive-developer"). Free text.',
  '- entry_type: one of devlog | bug | idea | content_seed | task.',
  '    devlog       = "I did / shipped X" — the raw log that later feeds blog/journey content.',
  '    bug          = something broken you found. Set target_repo so it can be delegated to sage.',
  '    task         = a concrete change you want made. Set target_repo to delegate it.',
  '    idea         = a thought to keep, not yet actionable.',
  '    content_seed = explicitly worth turning into a post / journey beat.',
  '- summary: one tight line.',
  '- target_repo (bug/task only): "owner/name" if you know the repo (e.g. "sielay/eidan"). Omit if',
  '    unsure — the entry is still logged, just not auto-delegated.',
  '',
  'Do not editorialise; capture faithfully. One journal_capture call per distinct item.',
].join('\n');

// Normalise a free-text/model-supplied entry_type to a known one; unknown ⇒ 'devlog' (the safe,
// non-actioning default). Case-insensitive, trims, maps a couple of common synonyms.
export function normalizeEntryType(raw: unknown): EntryType {
  const v = (typeof raw === 'string' ? raw : '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if ((ENTRY_TYPES as readonly string[]).includes(v)) return v as EntryType;
  if (v === 'log' || v === 'update' || v === 'progress') return 'devlog';
  if (v === 'fix' || v === 'defect') return 'bug';
  if (v === 'todo' || v === 'chore') return 'task';
  if (v === 'content' || v === 'post') return 'content_seed';
  return 'devlog';
}

// A repo string is routable only if it is a plausible "owner/name". Guards against opening code jobs
// against garbage the model might hand us.
export function isRoutableRepo(repo: unknown): repo is string {
  return typeof repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repo.trim());
}

// The single routing decision, kept pure for testing: should this entry open a code job, and against
// which repo. Only bug/task with a routable repo qualify.
export function codeJobTarget(entryType: EntryType, repo: unknown): string | null {
  if (!CODE_JOB_TYPES.has(entryType)) return null;
  return isRoutableRepo(repo) ? repo.trim() : null;
}