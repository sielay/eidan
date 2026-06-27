// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION, tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';

interface EscalationsService {
  raise(args: {
    severity: 'low' | 'medium' | 'high';
    reasonClass: string;
    suggestedAction?: string;
    evidence?: unknown[];
    metadata?: Record<string, unknown>;
    agentId?: string;
    conversationId?: string;
    userId?: string;
  }): Promise<{ id: string } | null>;
}

interface AskUserFallbackConfig {
  isNonInteractive: boolean;
}

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    Escalations?: EscalationsService;
    AskUserFallbackConfig?: AskUserFallbackConfig;
  }
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'ask_user fallback: when ask_user is called in non-interactive contexts (background agents, ' +
      'procedures), instead of erroring, logs the decision to escalations inbox and returns a stub ' +
      'response so the agent can continue.',
  },

  async setup(services: MatbotServices) {
    const svc = services as { Escalations?: EscalationsService; AskUserFallbackConfig?: AskUserFallbackConfig };

    const config: AskUserFallbackConfig = svc.AskUserFallbackConfig ?? {
      isNonInteractive: typeof process !== 'undefined' && !!process.env['IS_SUB_AGENT'],
    };

    services.hooks.register({
      on: 'toolresult',
      priority: 60,
      pluginName: 'ask-user-fallback',
      async handler(ctx) {
        const tool = ctx.tool.name;
        if (tool !== 'ask_user') return;

        if (!config.isNonInteractive) return;

        const args = ctx.tool.input as Record<string, unknown> | undefined;
        const type = args?.type as string | undefined;
        if (type !== 'confirm') return;

        // Only escalate if ask_user errored (e.g., no TTY in non-interactive context)
        if (!ctx.isError) return;

        const escalationsService = svc.Escalations;
        if (!escalationsService) {
          console.warn('[ask-user-fallback] escalations service not available');
          return;
        }

        const userId = tryCurrentPrincipal()?.id;
        const label = (args?.label as string | undefined) ?? 'Confirm';
        const name = (args?.name as string | undefined) ?? 'confirmation';
        const conversationId = ctx.session.id;

        const res = await escalationsService.raise({
          severity: 'medium',
          reasonClass: 'missing_input',
          suggestedAction: `Approve or deny: ${label}`,
          metadata: {
            tool: 'ask_user',
            type: 'confirm',
            name,
            label,
          },
          userId,
          conversationId,
        });

        if (res) {
          console.log(`[ask-user-fallback] escalated confirm gate "${label}" as ${res.id}`);
        }

        return {
          result: {
            decision: 'PENDING_HUMAN_REVIEW',
            escalation_id: res?.id ?? 'unknown',
            message: `${label}: decision escalated to inbox (non-interactive context)`,
          },
        };
      },
    });

    console.log('[ask-user-fallback] ask_user confirm gate fallback registered');
  },
};
