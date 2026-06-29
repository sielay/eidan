// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotServices, Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import { runProcedure } from './runner.js';
import type { ProcedureBridge } from './runner.js';
import type { ProcedureStore } from './procedure-store.js';

const DESCRIPTION = [
  'Run agent-authored JavaScript in a sealed sandbox that can ONLY compose other eidan tools.',
  'Inside the sandbox the single host capability is `await callTool(name, input)`; fetch, process,',
  'require, and fs do not exist, so a procedure cannot reach the filesystem, the network, or secrets',
  '— it can only orchestrate the allowlisted tools. Use this to collapse a deterministic multi-step',
  'tool pipeline (e.g. a data migration) into one step instead of many turns.',
  '',
  'Actions (TypeScript union):',
  "  { action: 'run'; source: string }                     // run JS now (ephemeral)",
  "  { action: 'promote'; name: string; source: string }   // save a proven procedure to your procedure library (asks the user to approve)",
  "  { action: 'run_saved'; name: string }                 // run a previously saved procedure by name",
  "  { action: 'list' }                                     // list saved procedures",
  '',
  'WHAT A PROCEDURE IS — runtime, user-/agent-authored automation that lives ONLY in the database',
  '(eidan.procedures), authored on the fly to serve THIS user. It is the agent equivalent of a saved',
  'shell alias: personal, ad-hoc, owned by the user, approved via `promote`. It is NOT source code and',
  'must never be committed to a repo or package.',
  '',
  'WHEN TO USE one: a one-off or user-specific deterministic pipeline you assemble during a',
  'conversation — "every Monday pull these rows, dedupe, and remember the result", a personal data',
  'migration, an idiosyncratic report only this user wants. Author it now; promote it if it proves out.',
  '',
  'WHEN NOT TO USE one — reach for a real plugin tool instead (code, shipped in a repo, reviewed) when',
  'the capability is general-purpose (useful to every operator, not just this user), stable, or',
  'performance-/correctness-sensitive. Recurring deterministic analytics/aggregations (e.g.',
  'cost/token/agent observability) are TOOLS, not procedures: if you would write the same procedure for',
  'everyone, that is the signal it belongs in code. Do not promote such things — say a tool is needed.',
  '',
  'Procedures are first-class objects in their own store (eidan.procedures). They are NOT knowledge',
  'entries and NOT SQL/psql — do not use recall, the db/psql plugin, or a database query to find or run',
  'one. Use this tool (list / run_saved) exclusively.',
].join('\n');

export function proceduresTool(services: MatbotServices, store: ProcedureStore, allow: (name: string) => boolean): Tool {
  return {
    name: 'procedures',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      required: ['action'],
      additionalProperties: false,
      properties: {
        action: { type: 'string', description: "one of run | promote | run_saved | list" },
        source: { type: 'string', description: 'JS source (run/promote)' },
        name:   { type: 'string', description: 'procedure name (promote/run_saved)' },
      },
    },
    executor: {
      async *execute(input, ctx) {
        const a = (input ?? {}) as { action?: string; source?: string; name?: string };
        const bridge = makeBridge(services, ctx, allow);
        switch (a.action) {
          case 'run': {
            if (!a.source) { yield { type: 'error', message: 'run requires `source`' }; return; }
            const out = await runProcedure(a.source, bridge);
            if (out.error) { yield { type: 'error', message: out.error, stdout: out.logs.join('\n') }; return; }
            yield { type: 'result', value: { result: out.result, logs: out.logs, toolCalls: out.toolCalls.map((c) => c.name) } };
            return;
          }
          case 'run_saved': {
            if (!a.name) { yield { type: 'error', message: 'run_saved requires `name`' }; return; }
            const src = await store.get(a.name);
            if (src === null) { yield { type: 'error', message: `no promoted procedure named "${a.name}"` }; return; }
            const out = await runProcedure(src, bridge);
            if (out.error) { yield { type: 'error', message: out.error, stdout: out.logs.join('\n') }; return; }
            yield { type: 'result', value: { result: out.result, logs: out.logs } };
            return;
          }
          case 'promote': {
            if (!a.name || !a.source) { yield { type: 'error', message: 'promote requires `name` and `source`' }; return; }
            // Human-approval gate. (A bicameral-critic pre-review is the documented follow-on; it
            // would run before this prompt and surface its verdict to the approver.)
            const ans = await ctx.prompt(`Approve saving procedure "${a.name}" to your procedure library? Type "yes" to confirm.`, 'no');
            if (ans.trim().toLowerCase() !== 'yes') { yield { type: 'result', value: { promoted: false, reason: 'not approved' } }; return; }
            const id = await store.save(a.name, a.source);
            yield { type: 'result', value: { promoted: true, id, name: a.name } };
            return;
          }
          case 'list': {
            const items = await store.list();
            yield { type: 'result', value: { procedures: items } };
            return;
          }
          default:
            yield { type: 'error', message: `unknown action: ${String(a.action)} (expected run | promote | run_saved | list)` };
        }
      },
    },
  };
}

// The bridge's host side: resolve an allowlisted tool and run it to completion in the SAME turn
// context (so the ambient principal and session carry through), reducing its event stream to a
// single value. A tool error becomes a thrown rejection the procedure can catch.
function makeBridge(services: MatbotServices, ctx: ToolContext, allow: (name: string) => boolean): ProcedureBridge {
  return {
    async call(name: string, input: unknown): Promise<unknown> {
      if (name === 'procedures' || !allow(name)) throw new Error(`tool not exposed to procedures: ${name}`);
      const tool = services.tools.resolve(name);
      if (!tool) throw new Error(`unknown tool: ${name}`);
      let result: unknown;
      let isError = false;
      const out: string[] = [];
      for await (const ev of tool.executor.execute(input, ctx)) {
        if (ev.type === 'result') result = ev.value;
        else if (ev.type === 'error') { isError = true; result = ev.message; }
        else if (ev.type === 'stdout') out.push(ev.chunk);
      }
      if (isError) throw new Error(typeof result === 'string' ? result : JSON.stringify(result));
      return result !== undefined ? result : out.join('');
    },
  };
}
