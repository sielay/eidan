// SPDX-License-Identifier: AGPL-3.0-or-later
// A shared agent tool that lists a provider's connected accounts together with the operator-authored
// `context` for each — so the agent can choose the right account (and follow any per-account guidance)
// before calling a post/read tool with `account: "<name>"`. No secrets are exposed.
import type { Tool } from '@matatbread/matbot-plugin-api';
import type { AccountStore } from './registry.js';

export function makeAccountsTool(provider: string, store: AccountStore): Tool {
  return {
    name: `${provider}_list_accounts`,
    description:
      `List the operator's connected ${provider} accounts with their handle, status and the operator's ` +
      `notes/context for each. Call this first when more than one account may exist (or to follow ` +
      `per-account guidance), then pass the chosen account's name as the \`account\` argument to the ` +
      `${provider} post/read tools.`,
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    executor: {
      async *execute(_input, _ctx) {
        const rows = await store.listAccounts();
        yield {
          type: 'result',
          value: {
            accounts: rows.map((a) => ({
              name: a.name,
              handle: a.host ? `${a.external_handle}@${a.host}` : a.external_handle,
              status: a.status,
              context: a.context,
            })),
          },
        };
      },
    },
  };
}
