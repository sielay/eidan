// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent tools for the `glue` plugin. Each tool is one capability area of the
// operator's Glue marketing suite, exposed as a multi-action tool (matbot's
// preferred shape) that proxies to a named Glue MCP tool. eidan stores
// nothing — every call is a live read/write against Glue (pull, don't
// duplicate). Writes are gated server-side by Glue's per-project
// agent_autonomy_level; an autonomy denial comes back as a clear error.
import type { Tool, ToolContext, ToolExecutor } from '@matatbread/matbot-plugin-api';
import { callGlueTool, GlueError, type GlueEndpoint } from './client.js';
import { secretOpt } from './vault.js';

// Resolve the Glue endpoint at call time: URL from install config (env), the
// X-MCP-Secret from the vault. Both absent-tolerant so the plugin still loads
// and the tools give an actionable message instead of throwing at boot.
async function resolveEndpoint(ctx: ToolContext): Promise<{ ep?: GlueEndpoint; error?: string }> {
  // Both the endpoint URL and the secret come from the vault (Settings → Glue marketing), so the
  // config lives in the shared DB and reaches every node with no per-node env push. The vault
  // backend still falls back to process.env when a key isn't in the DB, so seeding via env keeps
  // working — but the vault is the canonical source.
  const url = await secretOpt(ctx, 'EIDAN_GLUE_MCP_URL');
  if (!url) {
    return {
      error:
        'Glue is not configured — set EIDAN_GLUE_MCP_URL in the vault (Settings → Glue marketing) to the Glue MCP endpoint (e.g. https://glue.example.com/api/mcp).',
    };
  }
  const secret = await secretOpt(ctx, 'GLUE_MCP_SECRET');
  if (!secret) {
    return {
      error:
        "Missing GLUE_MCP_SECRET — add it in the vault (Settings → Glue marketing): Glue's MCP_GLUE_SECRET / X-MCP-Secret value.",
    };
  }
  return { ep: { url, secret } };
}

// Build a multi-action tool: `actions` maps the tool's `action` discriminator
// to the underlying Glue MCP tool name. The rest of the input (minus `action`)
// is passed straight through as the Glue tool's arguments.
function makeActionTool(
  name: string,
  description: string,
  actions: Record<string, string>,
): Tool {
  const executor: ToolExecutor = {
    async *execute(input, ctx) {
      const args = (input ?? {}) as Record<string, unknown>;
      const action = typeof args['action'] === 'string' ? (args['action'] as string) : undefined;
      if (!action) {
        yield { type: 'error', message: `action is required (one of: ${Object.keys(actions).join(', ')})` };
        return;
      }
      const remote = actions[action];
      if (!remote) {
        yield { type: 'error', message: `unknown action '${action}' (expected one of: ${Object.keys(actions).join(', ')})` };
        return;
      }
      const { ep, error } = await resolveEndpoint(ctx);
      if (!ep) {
        yield { type: 'error', message: error ?? 'Glue is not configured' };
        return;
      }
      const { action: _drop, ...rest } = args;
      void _drop;
      try {
        const value = await callGlueTool(ep, remote, rest, ctx.signal);
        yield { type: 'result', value };
      } catch (exc) {
        if (exc instanceof GlueError) {
          const suffix = exc.code === -32010 ? ' — raise the project\'s agent_autonomy_level in Glue to allow this.' : '';
          yield { type: 'error', message: `${exc.message}${suffix}` };
          return;
        }
        yield { type: 'error', message: exc instanceof Error ? exc.message : String(exc) };
      }
    },
  };
  return { name, description, inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] }, executor };
}

export function makeGlueTools(): Tool[] {
  const analytics = makeActionTool(
    'glue_analytics',
    [
      'Read marketing analytics from Glue (the operator\'s marketing suite). Read-only.',
      'Start with action "list_projects" to find the project_id / funnel_id you need.',
      'When presenting timeseries or breakdowns, render a chart for the user: emit a fenced',
      '```chart block whose body is a chart.js config { "type": "line"|"bar"|..., "data": {...}, "options"?: {...} }',
      '(e.g. a line chart for daily sessions, a bar chart for top pages or funnel steps). The chat UI renders it inline.',
      'Actions (TypeScript):',
      "  | { action: 'list_projects' }",
      "  | { action: 'web_metrics'; project_id: string; days?: 7 | 30 | 90 }   // sessions, top pages/referrers/countries, engagement",
      "  | { action: 'retention'; project_id: string; max_cohorts?: number }    // weekly cohort retention (w1/w2/w4/w8)",
      "  | { action: 'funnel_metrics'; funnel_id: string; days?: 7 | 30 | 90; cohort_by?: 'week'; split_by?: string }  // per-step conversion; split_by=<event property> for A/B",
    ].join('\n'),
    {
      list_projects: 'list_projects',
      web_metrics: 'get_web_metrics',
      retention: 'get_retention',
      funnel_metrics: 'get_funnel_metrics',
    },
  );

  const funnels = makeActionTool(
    'glue_funnels',
    [
      'Manage Glue conversion funnels (definitions + steps). Reads are open; writes need the project at autonomy level draft+ in Glue.',
      'A step filter matches web events: { event_type (required), path_pattern? (* = wildcard), properties_match? (exact equality per key) }.',
      'Actions (TypeScript):',
      "  | { action: 'list'; project_id: string; include_archived?: boolean }",
      "  | { action: 'get'; funnel_id: string }",
      "  | { action: 'create'; project_id: string; name: string; window_days?: number }   // window_days 1-365, default 7",
      "  | { action: 'update'; funnel_id: string; name?: string; window_days?: number; archived?: boolean }",
      "  | { action: 'delete'; funnel_id: string }",
      "  | { action: 'add_step'; funnel_id: string; name: string; filter: { event_type: string; path_pattern?: string; properties_match?: object } }",
      "  | { action: 'update_step'; step_id: string; name?: string; filter?: { event_type: string; path_pattern?: string; properties_match?: object } }",
      "  | { action: 'delete_step'; step_id: string }",
    ].join('\n'),
    {
      list: 'list_funnels',
      get: 'get_funnel',
      create: 'create_funnel',
      update: 'update_funnel',
      delete: 'delete_funnel',
      add_step: 'add_funnel_step',
      update_step: 'update_funnel_step',
      delete_step: 'delete_funnel_step',
    },
  );

  const lists = makeActionTool(
    'glue_lists',
    [
      'Manage Glue subscriber lists and topics. Reads are open; writes need the project at autonomy level draft+ (opt-out / unsubscribe are always allowed).',
      'A topic is a mailing list / segment keyed by (type, id) — both venture-defined (e.g. type "author", id "stephen-king").',
      'Actions (TypeScript):',
      "  | { action: 'list_subscribers'; project_id: string; opted_out?: boolean; confirmed?: boolean; q?: string; older_than?: string; limit?: number }",
      "  | { action: 'get_subscriber'; project_id: string; email: string }",
      "  | { action: 'update_subscriber'; project_id: string; email: string; opted_out?: boolean; confirmed?: boolean; attributes?: object }",
      "  | { action: 'list_topics'; project_id: string }",
      "  | { action: 'set_topic'; project_id: string; email: string; topic_id: string; subscribed: boolean }",
    ].join('\n'),
    {
      list_subscribers: 'list_subscribers',
      get_subscriber: 'get_subscriber',
      update_subscriber: 'update_subscriber',
      list_topics: 'list_topics',
      set_topic: 'set_subscriber_topic',
    },
  );

  const campaigns = makeActionTool(
    'glue_campaigns',
    [
      'Manage Glue bulk-email campaigns. create/update need autonomy draft+; scheduling needs schedule+; send_now needs publish+; cancel is always allowed.',
      'audience_filter (jsonb) supports: { topics?: { include: [{topic_type,topic_id}]; exclude?: [...]; mode?: "any"|"all" }; attributes_match?: object; segment_id?: string; manual_emails?: string[] }.',
      'Actions (TypeScript):',
      "  | { action: 'list'; project_id: string; status?: string; limit?: number }",
      "  | { action: 'get'; campaign_id: string }",
      "  | { action: 'create'; project_id: string; name: string; template_id?: string; audience_filter?: object }",
      "  | { action: 'update'; campaign_id: string; name?: string; template_id?: string; audience_filter?: object; status?: string; scheduled_at?: string }",
      "  | { action: 'send_now'; campaign_id: string }   // dispatch immediately (publish+)",
      "  | { action: 'cancel'; campaign_id: string }",
    ].join('\n'),
    {
      list: 'list_campaigns',
      get: 'get_campaign',
      create: 'create_campaign',
      update: 'update_campaign',
      send_now: 'send_campaign_now',
      cancel: 'cancel_campaign',
    },
  );

  return [analytics, funnels, lists, campaigns];
}
