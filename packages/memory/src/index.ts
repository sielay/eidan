// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { Db } from './db.js';
import { EidanMemory } from './eidan-memory.js';
import { EidanKnowledgeIndex } from './knowledge-index.js';
import { rememberTool, recallTool, conversationListTool, conversationArchiveTool, knowledgeCaptureWorkflowTool, knowledgeRecallTool, knowledgeCatalogueListTool } from './tools.js';

// Advertise EidanMemory on the service registry so other plugins (bundles) can consume the
// relational memory surface with full type safety: services.EidanMemory?.searchKnowledge(...).
declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    EidanMemory?: EidanMemory;
  }
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'eidan relational long-term memory (knowledge + notes over eidan.*, RLS-scoped): registers the EidanMemory service and the remember/recall tools.',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) throw new Error('EIDAN_DATABASE_URL (or DATABASE_URL) must be set for @eidandev/memory');
    const db = new Db(url);
    const mem = new EidanMemory(db);
    await services.register('EidanMemory', mem);
    // Expose the SAME relational knowledge as matbot's KnowledgeIndex, so skills/cognition/rumsfeld
    // read+write eidan.knowledge (one unified store) rather than a separate matbot index.
    await services.register('KnowledgeIndex', new EidanKnowledgeIndex(mem));
    services.tools.register(rememberTool(mem));
    services.tools.register(recallTool(mem));
    // Knowledge catalogue: capture transcripts with auto-tagging, and proactive recall by ventures/goals/issues.
    services.tools.register(knowledgeCaptureWorkflowTool(mem));
    services.tools.register(knowledgeRecallTool(mem));
    services.tools.register(knowledgeCatalogueListTool(mem));
    // Conversation housekeeping (agent-facing counterpart to the UI delete). RLS-scoped to the owner.
    services.tools.register(conversationListTool(db));
    services.tools.register(conversationArchiveTool(db));

    // Standing instructions: guide the assistant on knowledge capture + recall.
    services.hooks.register({
      on: 'screen',
      pluginName: 'memory',
      handler() {
        const instructions = [
          '## Knowledge Catalogue',
          'You have access to a knowledge catalogue for capturing and recalling learnings:',
          '',
          '- **knowledge_capture_workflow**: Save transcripts/summaries/articles with auto-extracted concepts, tagged to ventures/goals/issues',
          '- **knowledge_recall**: Proactively surface relevant learnings by venture/goal/issue/topic',
          '- **knowledge_catalogue_list**: Review and curate captured knowledge',
          '',
          'When the operator mentions a venture, goal, or problem, offer to surface relevant prior learnings. When they share a learning, offer to capture it.',
        ].join('\n');
        return { ephemeral: [{ type: 'text', text: instructions }] };
      },
    });

    // Proactive knowledge recall: when operator mentions ventures/goals/issues, surface relevant learnings.
    if (process.env['EIDAN_KNOWLEDGE_PROACTIVE_RECALL'] !== '0') {
      services.hooks.register({
        on: 'screen',
        pluginName: 'memory',
        async handler(ctx) {
          const msgs = ctx.session.messages;
          const last = msgs[msgs.length - 1] as { role?: string; content?: unknown[] } | undefined;
          if (last?.role !== 'user') return;

          // Extract mentioned keywords (ventures, goals, issues) from the user's message.
          const lastContent = last.content ?? [];
          const text = lastContent
            .filter((b) => typeof b === 'object' && b !== null && (b as Record<string, unknown>).type === 'text')
            .map((b) => (b as Record<string, unknown>).text ?? '')
            .join(' ')
            .toLowerCase();

          // Keyword detection with word boundaries to avoid false positives.
          const keywords = ['venture', 'goal', 'objective', 'problem', 'challenge', 'issue', 'delegation', 'pricing', 'marketing'];
          const wordBoundaryRegex = new RegExp(`\\b(${keywords.join('|')})\\b`);
          if (!wordBoundaryRegex.test(text)) return null;

          // Surface relevant knowledge entries from the catalogue.
          const entries = await mem.catalogueRecall({ limit: 3, query: text });
          if (!entries.length) return null;

          // Format the recalled knowledge as ephemeral context for the model.
          const briefing = [
            '## Recalled from your knowledge catalogue:',
            '',
            ...entries.map((e, i) => {
              const tags = Object.entries(e.tags)
                .filter(([, v]) => Array.isArray(v) && v.length > 0)
                .map(([k, v]) => `${k}: ${(v as string[]).join(', ')}`)
                .join('; ');
              return `**${i + 1}. ${e.title}** (${e.source}${e.date_captured ? `, ${new Date(e.date_captured).toLocaleDateString()}` : ''})\n${tags ? `*Tags: ${tags}*\n` : ''}${e.content.slice(0, 200)}${e.content.length > 200 ? '...' : ''}`;
            }),
            '',
            'Consider these learnings in your response. Call knowledge_recall() for more details if needed.',
          ].join('\n');

          return { ephemeral: [{ type: 'text', text: briefing }] };
        },
      });
    }
  },
};
