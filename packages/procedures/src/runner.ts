// SPDX-License-Identifier: AGPL-3.0-or-later
import ivm from 'isolated-vm';

// Execute agent-authored JS in a bare V8 isolate whose ONLY host capability is callTool(): no
// fetch, process, require, or fs exist inside. callTool marshals (by JSON string) to the bridge,
// which the host binds to an allowlisted subset of the tool registry under the ambient principal.
export interface ProcedureBridge {
  call(name: string, input: unknown): Promise<unknown>;
}

export interface ProcedureRun {
  logs: string[];
  result: unknown;
  error: string | null;
  toolCalls: Array<{ name: string; input: unknown }>;
}

export interface RunOpts {
  memoryLimitMb?: number;
  timeoutMs?: number;
}

export async function runProcedure(source: string, bridge: ProcedureBridge, opts?: RunOpts): Promise<ProcedureRun> {
  const memoryLimit = opts?.memoryLimitMb ?? 128;
  const timeout = opts?.timeoutMs ?? 30_000;
  const isolate = new ivm.Isolate({ memoryLimit });
  const logs: string[] = [];
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  try {
    const context = await isolate.createContext();
    const jail = context.global;
    await jail.set('global', jail.derefInto());

    await jail.set('__log', new ivm.Reference((msg: string) => { logs.push(String(msg)); }));
    await jail.set('__callTool', new ivm.Reference(async (name: string, inputJson: string) => {
      const input = JSON.parse(inputJson) as unknown;
      toolCalls.push({ name, input });
      const out = await bridge.call(name, input); // may throw -> rejects inside the isolate
      return JSON.stringify(out ?? null);
    }));

    // Top-level lexical bindings in a global Script persist across runs in the same context, so the
    // procedure (run next) sees `console` and `callTool`.
    const bootstrap =
      'const console = { log: (...a) => __log.applySync(undefined, ' +
      '[a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")]) };\n' +
      'async function callTool(name, input) {\n' +
      '  const res = await __callTool.apply(undefined, [name, JSON.stringify(input ?? null)], { result: { promise: true } });\n' +
      '  return JSON.parse(res);\n' +
      '}\n';
    await (await isolate.compileScript(bootstrap)).run(context, { timeout });

    let result: unknown;
    let error: string | null = null;
    try {
      const wrapped = '(async () => {\n' + source + '\n})()';
      result = await (await isolate.compileScript(wrapped)).run(context, { promise: true, copy: true, timeout });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    return { logs, result, error, toolCalls };
  } finally {
    isolate.dispose();
  }
}
