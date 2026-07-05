// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

type RecoveryStrategy = 'STOP_AND_ESCALATE' | 'RETIRE_TOOL_CALL' | 'CONTINUE_WITH_ERROR' | 'RETRY_WITH_PARAMS';

interface FailureDecision {
  strategy: RecoveryStrategy;
  reasoning: string;
  suggestedAction?: string;
}

interface ToolResultContext {
  isError: boolean;
  result: unknown;
  tool: { name: string; input: unknown };
  session: { id: string };
}

function isEnabled(): boolean {
  return process.env['EIDAN_TOOL_FAILURE_DETECTION'] === '1' || process.env['EIDAN_TOOL_FAILURE_DETECTION'] === 'true';
}

function getLightweightModel(): string {
  return process.env['EIDAN_TOOL_FAILURE_MODEL'] ?? 'claude-haiku-4-5';
}

async function decideRecoveryStrategy(
  services: MatbotServices,
  toolName: string,
  toolInput: unknown,
  errorMessage: string,
): Promise<FailureDecision | null> {
  const singleTurn = services.singleTurn;
  if (!singleTurn) return null;

  const prompt = `Tool failure analysis:

Tool name: ${toolName}
Error: ${errorMessage}
Input: ${JSON.stringify(toolInput, null, 2)}

You are deciding how the LLM should handle this tool failure. Choose ONE recovery strategy:

1. STOP_AND_ESCALATE: The error is critical and should stop the turn (e.g., authentication failure, permission denied).
2. RETIRE_TOOL_CALL: The tool call was malformed or invalid; the model should try a different approach without retrying this tool.
3. CONTINUE_WITH_ERROR: The error is informative; let the model see it and decide what to do next.
4. RETRY_WITH_PARAMS: The tool might succeed with different parameters; suggest what to try.

Respond with ONLY valid JSON (no markdown, no extra text):
{
  "strategy": "STRATEGY_NAME",
  "reasoning": "brief explanation",
  "suggestedAction": "optional suggested action for the model"
}`;

  try {
    const lightweightModel = getLightweightModel();
    const resp = await singleTurn({ provider: lightweightModel, prompt });
    const text = typeof resp?.text === 'string' ? resp.text : '';
    const decision = JSON.parse(text) as FailureDecision;

    const validStrategies: RecoveryStrategy[] = ['STOP_AND_ESCALATE', 'RETIRE_TOOL_CALL', 'CONTINUE_WITH_ERROR', 'RETRY_WITH_PARAMS'];
    if (!validStrategies.includes(decision.strategy)) {
      console.warn(`[tool-failure-handler] invalid strategy from LLM: ${decision.strategy}`);
      return null;
    }

    return decision;
  } catch (e) {
    console.warn('[tool-failure-handler] decision call failed:', e instanceof Error ? e.message : String(e));
    return null;
  }
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Tool failure detection & decision-making: prevents LLM hallucination on tool failures by detecting errors and using a lightweight LLM to decide recovery strategy. Enable with EIDAN_TOOL_FAILURE_DETECTION=1.',
  },

  async setup(services: MatbotServices) {
    if (!isEnabled()) {
      console.log('[tool-failure-handler] disabled (EIDAN_TOOL_FAILURE_DETECTION not set)');
      return;
    }

    const model = getLightweightModel();
    console.log(`[tool-failure-handler] enabled (model=${model})`);

    services.hooks.register({
      on: 'toolresult',
      priority: 10,
      pluginName: 'tool-failure-handler',
      async handler(ctx: ToolResultContext) {
        if (!ctx.isError) return;

        const toolName = ctx.tool.name;
        const errorMessage = typeof ctx.result === 'string'
          ? ctx.result
          : (ctx.result instanceof Error ? ctx.result.message : JSON.stringify(ctx.result));

        console.log(`[tool-failure-handler] tool error: ${toolName}: ${errorMessage}`);

        const decision = await decideRecoveryStrategy(
          services,
          toolName,
          ctx.tool.input,
          errorMessage,
        );

        if (!decision) {
          console.log('[tool-failure-handler] decision unavailable, passing error through');
          return;
        }

        console.log(`[tool-failure-handler] recovery strategy: ${decision.strategy}`);

        // Build the recovery guidance for the model
        const guidance = [
          `**Tool Failure Recovery Guidance:**`,
          `- Tool: ${toolName}`,
          `- Error: ${errorMessage}`,
          `- Recovery Strategy: ${decision.strategy}`,
          `- Reasoning: ${decision.reasoning}`,
          ...(decision.suggestedAction ? [`- Suggested Action: ${decision.suggestedAction}`] : []),
        ].join('\n');

        if (decision.strategy === 'STOP_AND_ESCALATE') {
          // Break the LLM stream on critical failures
          const msg = `Critical tool failure (${toolName}): ${errorMessage}\n\n${guidance}\n\n**Action:** This turn is being stopped and escalated for human review.`;
          return { result: msg };
        }

        if (decision.strategy === 'RETIRE_TOOL_CALL') {
          // Let the model know to try a different approach
          return {
            result: `Tool "${toolName}" failed: ${errorMessage}\n\n${guidance}\n\nThe model should try an alternative approach instead of retrying this tool.`,
          };
        }

        if (decision.strategy === 'RETRY_WITH_PARAMS') {
          // Suggest retry parameters
          return {
            result: `Tool "${toolName}" failed: ${errorMessage}\n\n${guidance}\n\nConsider retrying with different parameters.`,
          };
        }

        // CONTINUE_WITH_ERROR: let the error through with added context
        return {
          result: `${errorMessage}\n\n${guidance}`,
        };
      },
    });
  },
};
