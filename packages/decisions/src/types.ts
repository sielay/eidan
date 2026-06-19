// SPDX-License-Identifier: AGPL-3.0-or-later

export type DecisionStatus = 'proposed' | 'accepted' | 'superseded' | 'rejected';

// One recorded decision, stored in the 'decisions' KV namespace (eidan.kv) and queryable via the
// matbot Store query engine. `version` is minted by the store layer on every write.
export interface DecisionRecord {
  id:         string;
  version:    string;
  title:      string;
  decision:   string;
  rationale:  string;
  tags:       string[];
  links:      string[];        // [[knowledge-slug]] refs or URLs — connective tissue, not burial
  status:     DecisionStatus;
  supersedes: string | null;   // id of a decision this one replaces
  createdAt:  string;
  updatedAt:  string;
}

// Durable per-job cursor: where a recurring job/agent left off, so the next run resumes rather than
// repeating. Keyed by `job` (which is also the record id).
export interface JobCursorRecord {
  id:        string;           // == job
  version:   string;
  job:       string;
  state:     Record<string, unknown>;
  note:      string;
  updatedAt: string;
}
