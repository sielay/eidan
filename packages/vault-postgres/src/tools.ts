// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Tool } from '@matatbread/matbot-plugin-api';
import type { EidanSecrets } from './secrets-service.js';

// One multi-action tool for the agent to HELP a user manage their integration secrets — without
// ever handling a secret VALUE. Operator rule: secret values must never pass through the LLM. So
// this tool is value-free: it lists what's set (metadata only), removes a secret, or *requests*
// one (returns a structured prompt the frontend renders as a SECURE entry field that posts the
// value straight to the backend, bypassing the model). Actual writes happen over the secure UI
// route (@eidandev/secrets-api), not here.
const DESCRIPTION = `Help the user manage their own encrypted integration secrets (calendar feed URLs, IMAP/SMTP credentials, API keys) — WITHOUT ever seeing or handling the secret value. Values are entered by the user in a secure Settings field and never shown to you.

action contract (TypeScript):
  { action: 'list' }                                    // metadata only: which secret names are set, and when (NO values)
  | { action: 'delete'; name: string }                  // remove one of the user's secrets by name
  | { action: 'request'; name: string; reason?: string } // ask the user to provide a secret: returns a secure-entry prompt the UI renders; you NEVER receive the value

NEVER ask the user to paste a secret value into chat, and never accept one — use action 'request' so they enter it securely in Settings. Use the exact env-style name a plugin documents (e.g. EIDAN_ICAL_FEED_URLS, EIDAN_IMAP_HOST, EIDAN_IMAP_PASSWORD, EIDAN_GOOGLE_REFRESH_TOKEN). After the user sets it, the plugin can use it immediately — no restart.`;

export function secretTool(secrets: EidanSecrets): Tool {
  return {
    name: 'secret',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'delete', 'request'] },
        name: { type: 'string', description: 'Exact secret name, e.g. EIDAN_ICAL_FEED_URLS' },
        reason: { type: 'string', description: 'Why the secret is needed (shown to the user; only for action=request)' },
      },
      required: ['action'],
    },
    executor: {
      async *execute(input: Record<string, unknown>) {
        const action = input['action'];
        if (action === 'list') {
          const meta = await secrets.listMetadata();
          yield { type: 'result', value: { secrets: meta } };
          return;
        }
        if (action === 'delete') {
          const name = typeof input['name'] === 'string' ? input['name'] : '';
          if (!name) {
            yield { type: 'error', message: "action 'delete' requires 'name'." };
            return;
          }
          const removed = await secrets.deleteSecret(name);
          yield { type: 'result', value: { ok: true, name, removed } };
          return;
        }
        if (action === 'request') {
          const name = typeof input['name'] === 'string' ? input['name'] : '';
          if (!name) {
            yield { type: 'error', message: "action 'request' requires 'name'." };
            return;
          }
          const reason = typeof input['reason'] === 'string' ? input['reason'] : undefined;
          // A structured prompt for the frontend to render as a secure (masked) input that POSTs
          // the value to the secrets API directly — the value never returns to this turn.
          yield {
            type: 'result',
            value: {
              secure_entry: {
                name,
                ...(reason !== undefined ? { reason } : {}),
                endpoint: `/api/me/secrets/${encodeURIComponent(name)}`,
                method: 'PUT',
              },
              message: `Ask the user to enter ${name} in Settings → Connections (secure field). The value is never shown to the assistant.`,
            },
          };
          return;
        }
        yield { type: 'error', message: `unknown action "${String(action)}" (expected list | delete | request).` };
      },
    },
  };
}
