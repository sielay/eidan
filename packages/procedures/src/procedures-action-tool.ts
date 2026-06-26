// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotServices, Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import type { ProcedureStore } from './procedure-store.js';
import { runProcedure } from './runner.js';
import type { ProcedureBridge } from './runner.js';

const DESCRIPTION = [
  'Manage saved procedures: list, view, run, delete, edit, or schedule.',
  '',
  'Actions (TypeScript union):',
  "  { action: 'list' }                    // → { procedures: [...] }",
  "  { action: 'get'; name: string }       // → { name, source, created_at, updated_at, last_run_at?, history: [...] }",
  "  { action: 'delete'; name: string }    // → { deleted: true }",
  "  { action: 'run'; name: string }       // → { execution_id, status: queued | running | completed | failed }",
  "  { action: 'edit'; name: string; source: string }  // → update saved procedure",
  "  { action: 'schedule'; name: string; interval: string }  // → set recurring schedule (cron interval)",
  "  { action: 'get_result'; execution_id: string }  // → { status, result?, error?, duration_ms? }",
].join('\n');

export function proceduresActionTool(store: ProcedureStore, services: MatbotServices, allow: (name: string) => boolean): Tool {
  return {
    name: 'procedures_action',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      required: ['action'],
      additionalProperties: false,
      properties: {
        action: { type: 'string', description: 'one of list | get | delete | run | edit | schedule | get_result' },
        name: { type: 'string', description: 'procedure name (get/delete/run/edit/schedule)' },
        source: { type: 'string', description: 'new source code (edit)' },
        interval: { type: 'string', description: 'cron interval or schedule expression (schedule)' },
        execution_id: { type: 'string', description: 'execution id (get_result)' },
      },
    },
    executor: {
      async *execute(input, ctx) {
        const a = (input ?? {}) as { action?: string; name?: string; source?: string; interval?: string; execution_id?: string };
        switch (a.action) {
          case 'list': {
            const items = await store.list();
            yield { type: 'result', value: { procedures: items } };
            return;
          }
          case 'get': {
            if (!a.name) { yield { type: 'error', message: 'get requires `name`' }; return; }
            const detail = await store.getDetail(a.name);
            if (!detail) { yield { type: 'error', message: `no procedure named "${a.name}"` }; return; }
            const history = await store.getExecutionHistory(a.name, 5);
            yield { type: 'result', value: { ...detail, history } };
            return;
          }
          case 'delete': {
            if (!a.name) { yield { type: 'error', message: 'delete requires `name`' }; return; }
            const deleted = await store.delete(a.name);
            if (!deleted) { yield { type: 'error', message: `no procedure named "${a.name}"` }; return; }
            yield { type: 'result', value: { deleted: true, name: a.name } };
            return;
          }
          case 'run': {
            if (!a.name) { yield { type: 'error', message: 'run requires `name`' }; return; }
            const src = await store.get(a.name);
            if (!src) { yield { type: 'error', message: `no procedure named "${a.name}"` }; return; }
            const execId = await store.recordExecution(a.name, 'running');
            const start = Date.now();
            try {
              const bridge = makeBridge(services, ctx, allow);
              const out = await runProcedure(src, bridge);
              const duration = Date.now() - start;
              if (out.error) {
                await store.updateExecution(execId, 'failed', undefined, out.error, duration);
                yield { type: 'result', value: { execution_id: execId, status: 'failed', error: out.error, logs: out.logs } };
              } else {
                await store.updateExecution(execId, 'completed', out.result, undefined, duration);
                yield { type: 'result', value: { execution_id: execId, status: 'completed', result: out.result, logs: out.logs } };
              }
            } catch (e) {
              const duration = Date.now() - start;
              const errMsg = e instanceof Error ? e.message : String(e);
              await store.updateExecution(execId, 'failed', undefined, errMsg, duration);
              yield { type: 'error', message: errMsg };
            }
            return;
          }
          case 'edit': {
            if (!a.name) { yield { type: 'error', message: 'edit requires `name`' }; return; }
            if (!a.source) { yield { type: 'error', message: 'edit requires `source`' }; return; }
            const id = await store.save(a.name, a.source);
            yield { type: 'result', value: { updated: true, name: a.name, id } };
            return;
          }
          case 'schedule': {
            if (!a.name) { yield { type: 'error', message: 'schedule requires `name`' }; return; }
            if (!a.interval) { yield { type: 'error', message: 'schedule requires `interval`' }; return; }
            yield { type: 'error', message: 'schedule action not yet implemented' };
            return;
          }
          case 'get_result': {
            if (!a.execution_id) { yield { type: 'error', message: 'get_result requires `execution_id`' }; return; }
            const exec = await store.getExecution(a.execution_id);
            if (!exec) { yield { type: 'error', message: `no execution with id "${a.execution_id}"` }; return; }
            yield { type: 'result', value: exec };
            return;
          }
          default:
            yield { type: 'error', message: `unknown action: ${String(a.action)} (expected list | get | delete | run | edit | schedule | get_result)` };
        }
      },
    },
  };
}

function makeBridge(services: MatbotServices, ctx: ToolContext, allow: (name: string) => boolean): ProcedureBridge {
  return {
    async call(name: string, input: unknown): Promise<unknown> {
      // Disallow procedures from calling procedures or procedures_action tools to prevent:
      // 1. Recursive loops (procedure A calls procedure B which calls procedure A)
      // 2. Self-management (a procedure deleting itself or other procedures)
      // 3. Uncontrolled procedure chaining (procedures triggering other procedures without operator oversight)
      // Only tools explicitly allowlisted in EIDAN_PROCEDURE_TOOLS (env var) are exposed to procedures.
      // Operators must carefully audit this list as any tool here gains access to the procedure's context (user_id, principal).
      // Do NOT allowlist: secrets_action, vault, auth tools, or any tool that directly modifies system state without user confirmation.
      // Risk: a malicious or buggy promoted procedure could escalate privileges or cause unintended side effects.
      if (name === 'procedures' || name === 'procedures_action' || !allow(name)) throw new Error(`tool not exposed to procedures: ${name}`);
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
