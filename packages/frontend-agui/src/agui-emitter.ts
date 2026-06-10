// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PipelineEvent, Session, Message } from '@matatbread/matbot-plugin-api';

// AG-UI event-type strings. These are the stable protocol constants — @ag-ui/core's `EventType`
// enum has value === name, so the eidan Next client (lib/api/turn.ts) matches on exactly these.
// Hardcoded (vs importing @ag-ui/core) to stay dependency-free and avoid a const-enum runtime trap.
const E = {
  RUN_STARTED: 'RUN_STARTED',
  RUN_FINISHED: 'RUN_FINISHED',
  RUN_ERROR: 'RUN_ERROR',
  TEXT_MESSAGE_START: 'TEXT_MESSAGE_START',
  TEXT_MESSAGE_CONTENT: 'TEXT_MESSAGE_CONTENT',
  TEXT_MESSAGE_END: 'TEXT_MESSAGE_END',
  TOOL_CALL_START: 'TOOL_CALL_START',
  TOOL_CALL_ARGS: 'TOOL_CALL_ARGS',
  TOOL_CALL_END: 'TOOL_CALL_END',
  TOOL_CALL_RESULT: 'TOOL_CALL_RESULT',
} as const;

export type AguiEvent = Record<string, unknown>;

function newId(): string { return crypto.randomUUID().replace(/-/g, ''); }
function stringifyResult(r: unknown): string { return typeof r === 'string' ? r : JSON.stringify(r ?? null); }

function lastIdByRole(s: Session, role: Message['role']): string {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m && m.role === role) return m.id;
  }
  return '';
}

// One instance per turn. Maps matbot PipelineEvents onto AG-UI events, mirroring the eidan Python
// AguiEmitter: lazy text-message bracketing, the tool-call quartet, and RUN_FINISHED carrying the
// persisted message ids for client reconciliation. `map()` returns 0+ AG-UI events per pipeline event.
export class AguiEmitter {
  private textMessageId: string | null = null;
  private finished = false;
  private readonly threadId: string;
  private readonly runId: string;

  constructor(threadId: string) {
    this.threadId = threadId;
    this.runId = newId();
  }

  start(): AguiEvent[] {
    return [{ type: E.RUN_STARTED, threadId: this.threadId, runId: this.runId }];
  }

  map(ev: PipelineEvent): AguiEvent[] {
    switch (ev.type) {
      case 'text-delta':
        return this.onText(ev.delta);
      case 'tool:start': {
        const out = this.closeText();
        out.push({ type: E.TOOL_CALL_START, toolCallId: ev.callId, toolCallName: ev.name });
        out.push({ type: E.TOOL_CALL_ARGS, toolCallId: ev.callId, delta: JSON.stringify(ev.input ?? {}) });
        out.push({ type: E.TOOL_CALL_END, toolCallId: ev.callId });
        return out;
      }
      case 'tool:end':
        return [{ type: E.TOOL_CALL_RESULT, messageId: newId(), toolCallId: ev.callId, content: stringifyResult(ev.result), role: 'tool' }];
      case 'done':
        return this.onComplete(ev.session);
      case 'error':
        return this.error(ev.error);
      case 'aborted':
        return this.error(`aborted: ${ev.reason}`);
      default:
        return [];
    }
  }

  error(message: string): AguiEvent[] {
    if (this.finished) return [];
    this.finished = true;
    const out = this.closeText();
    out.push({ type: E.RUN_ERROR, message: message || 'run failed' });
    return out;
  }

  private onText(delta: string): AguiEvent[] {
    const out: AguiEvent[] = [];
    if (this.textMessageId === null) {
      this.textMessageId = newId();
      out.push({ type: E.TEXT_MESSAGE_START, messageId: this.textMessageId });
    }
    out.push({ type: E.TEXT_MESSAGE_CONTENT, messageId: this.textMessageId, delta });
    return out;
  }

  private closeText(): AguiEvent[] {
    if (this.textMessageId === null) return [];
    const id = this.textMessageId;
    this.textMessageId = null;
    return [{ type: E.TEXT_MESSAGE_END, messageId: id }];
  }

  private onComplete(session: Session): AguiEvent[] {
    this.finished = true;
    const out = this.closeText();
    out.push({
      type: E.RUN_FINISHED,
      threadId: this.threadId,
      runId: this.runId,
      result: {
        user_message_id: lastIdByRole(session, 'user'),
        assistant_message_id: lastIdByRole(session, 'assistant'),
        iterations: session.messages.filter((m) => m.role === 'assistant').length,
      },
    });
    return out;
  }
}
