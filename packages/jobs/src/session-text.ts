// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure session helpers (type-only matbot imports, erased at runtime) — unit-testable in isolation,
// away from the runner's pg/runAs dependencies.
import type { Session, MessageContent } from '@matatbread/matbot-plugin-api';

// The final assistant message's text (its text blocks joined with newlines), or '' if the turn
// produced no assistant message / no text. Non-text blocks (tool calls/results) are ignored.
export function lastAssistantText(s: Session): string {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m && m.role === 'assistant') {
      return m.content
        .filter((c): c is Extract<MessageContent, { type: 'text' }> => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
    }
  }
  return '';
}
