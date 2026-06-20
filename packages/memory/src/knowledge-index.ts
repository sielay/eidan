// SPDX-License-Identifier: AGPL-3.0-or-later
import type { KnowledgeIndex, KnowledgeEntry } from '@matatbread/matbot-plugin-api';
import type { EidanMemory, KnowledgeHit } from './eidan-memory.js';

// Adapts eidan's relational memory (eidan.knowledge) to matbot's KnowledgeIndex interface, so the
// matbot skills / cognition / rumsfeld plugins index into and search the SAME knowledge as the
// remember/recall tools — ONE unified store, not a parallel index. Registered by @eidandev/memory,
// so it's present (RLS-scoped via the ambient principal) before those plugins set up.
export class EidanKnowledgeIndex implements KnowledgeIndex {
  private readonly mem: EidanMemory;
  constructor(mem: EidanMemory) {
    this.mem = mem;
  }

  // A matbot KnowledgeEntry (e.g. a skill doc) -> an eidan.knowledge row. eidan keys rows by
  // (skill, title) and UPSERTS, so re-indexing the same entry updates in place, never duplicates.
  async index(entry: KnowledgeEntry): Promise<void> {
    const skill = entry.tags[0] ?? entry.source.type ?? 'knowledge';
    const title = entry.entities[0] ?? entry.summary ?? entry.id;
    await this.mem.remember({
      skill,
      title,
      body: entry.content,
      source: entry.source.uuid,
      sourceType: entry.source.type,
    });
  }

  async search(terms: Array<{ term: string; context?: string }>, _signal: AbortSignal): Promise<KnowledgeEntry[]> {
    const query = terms.map((t) => t.term).filter(Boolean).join(' ');
    if (query === '') return [];
    const hits = await this.mem.searchKnowledge(query, 10);
    return hits.map((h) => this.toEntry(h));
  }

  // eidan.knowledge row -> KnowledgeEntry. rumsfeld reads entities[0] (the name) + content; skills
  // doesn't read back. Timestamps aren't surfaced by the recall query and no consumer uses them.
  private toEntry(h: KnowledgeHit): KnowledgeEntry {
    return {
      id: h.id,
      version: '1',
      entities: [h.title],
      tags: [h.skill],
      summary: h.title,
      content: h.body,
      source: { type: 'eidan', uuid: h.id },
      confidence: h.rank,
      createdAt: '',
      updatedAt: '',
    };
  }
}
