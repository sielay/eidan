// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from '@matatbread/matbot-plugin-api';
import { lastAssistantText } from './session-text.js';

interface Block { type: string; text?: string }
interface Msg { role: string; content: Block[] }
const session = (messages: Msg[]): Session => ({ messages } as unknown as Session);
const t = (text: string): Block => ({ type: 'text', text });

describe('lastAssistantText', () => {
  it('returns empty for no messages or no assistant message', () => {
    assert.equal(lastAssistantText(session([])), '');
    assert.equal(lastAssistantText(session([{ role: 'user', content: [t('hi')] }])), '');
  });

  it('returns the assistant message text', () => {
    assert.equal(
      lastAssistantText(session([
        { role: 'user', content: [t('q')] },
        { role: 'assistant', content: [t('answer')] },
      ])),
      'answer',
    );
  });

  it('returns the LAST assistant message when several exist', () => {
    assert.equal(
      lastAssistantText(session([
        { role: 'assistant', content: [t('first')] },
        { role: 'user', content: [t('more')] },
        { role: 'assistant', content: [t('latest')] },
      ])),
      'latest',
    );
  });

  it('joins multiple text blocks with newlines and ignores non-text blocks', () => {
    assert.equal(
      lastAssistantText(session([
        { role: 'assistant', content: [t('line1'), { type: 'tool_use', text: 'IGNORED' }, t('line2')] },
      ])),
      'line1\nline2',
    );
  });

  it('returns empty when the last assistant message has no text blocks', () => {
    assert.equal(lastAssistantText(session([{ role: 'assistant', content: [{ type: 'tool_use' }] }])), '');
  });
});
