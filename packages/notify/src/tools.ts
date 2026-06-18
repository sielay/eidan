// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool } from '@matatbread/matbot-plugin-api';
import type { Notify } from './notify.js';

// Agent-facing send tool. The notify plugin's Notify service is fire-and-forget event routing
// (node.startup/job.update/…); this is the on-demand counterpart the assistant can call. It's
// FREE-FORM: the agent picks the channel + destination at call time — no operator-declared route is
// needed. The capability boundary is just "do we hold a bot token for that channel" (operator-set);
// the destination is the agent's choice, which matches how an operator expects to ask "post X to #y".
export function notifyTool(notify: Notify, caps: { slack: boolean; telegram: boolean }): Tool {
  const available = [caps.slack ? 'slack' : null, caps.telegram ? 'telegram' : null].filter(Boolean) as string[];
  const availLine = available.length
    ? `Channels with a bot token configured: ${available.join(', ')}.`
    : 'No channel has a bot token yet — tell the user to add one in `eidan` → Integrations, then retry.';
  return {
    name: 'send_message',
    description: `Send a message to a Slack channel or Telegram chat. You choose the destination directly — no per-channel setup is needed beyond the operator having added the bot token. ${availLine}`,
    inputSchema: {
      type: 'object',
      required: ['channel', 'target', 'text'],
      additionalProperties: false,
      properties: {
        channel: { type: 'string', enum: ['slack', 'telegram'], description: 'Which messenger to send through.' },
        target: { type: 'string', description: 'Destination. Slack: a channel like "#eidan-updates" or its id "C0123456". Telegram: the numeric chat id.' },
        text: { type: 'string', description: 'The message body (plain text).' },
      },
    },
    executor: {
      async *execute(input) {
        const { channel, target, text } = input as { channel: string; target: string; text: string };
        const res = await notify.sendTo(channel, target, text);
        if (res.dryRun) { yield { type: 'result', value: { sent: false, dryRun: true, note: 'EIDAN_NOTIFY_DRYRUN is on — message logged, not delivered', channel, target } }; return; }
        if (!res.ok) { yield { type: 'result', value: { sent: false, channel, target, error: res.error } }; return; }
        yield { type: 'result', value: { sent: true, channel, target } };
      },
    },
  };
}
