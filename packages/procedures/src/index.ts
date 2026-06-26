// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { Db } from './db.js';
import { ProcedureStore } from './procedure-store.js';
import { proceduresTool } from './procedures-tool.js';

// Export archaeology procedures for easy access
export { driveDeepScan, mailThreadArchaeology, ideaExtractionPipeline } from './archaeology-procedures.js';

// The set of tools a procedure may compose is operator-controlled (deny-by-default elsewhere is the
// allowlist's job): EIDAN_PROCEDURE_TOOLS is a comma list; it defaults to the memory tools so the
// plugin is useful out of the box without exposing anything that can leave the tool sandbox.
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'Sandboxed agent-authored procedures: run JS that composes an allowlisted subset of eidan tools in an isolated-vm, ephemeral or promoted to the knowledge graph.',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) throw new Error('EIDAN_DATABASE_URL (or DATABASE_URL) must be set for @eidandev/procedures');
    const store = new ProcedureStore(new Db(url));
    const allowed = new Set(
      (process.env['EIDAN_PROCEDURE_TOOLS'] ?? 'remember,recall').split(',').map((s) => s.trim()).filter(Boolean),
    );
    const allow = (name: string): boolean => allowed.has(name);
    services.tools.register(proceduresTool(services, store, allow));
  },
};
