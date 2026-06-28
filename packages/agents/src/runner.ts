// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotServices, Session, MessageContent, Principal } from '@matatbread/matbot-plugin-api';
import { runAs } from '@matatbread/matbot-plugin-api';
import type { AgentsStore } from './store.js';

interface ProviderCfg {
  name: string;
  module: string;
  model: string;
  endpoint?: string;
  credentials?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
}

// Per-turn model selection. The host exposes the live provider map as `services.providers`. When an
// agent specifies a `model`, clone its base provider profile (module/endpoint/credentials) with the
// model overridden and register it under a synthetic name — letting an agent run ANY model (e.g. any
// OpenRouter slug) without a restart or a hand-authored profile. No model ⇒ use the base provider.
export function effectiveProvider(services: MatbotServices, baseProvider: string, model: string | null): string {
  if (!model) return baseProvider;
  const providers = (services as unknown as { providers?: Map<string, ProviderCfg> }).providers;
  if (!providers) return baseProvider;
  const synthName = `${baseProvider}::${model}`;
  if (!providers.has(synthName)) {
    const base = providers.get(baseProvider);
    if (!base) return baseProvider; // unknown base — let it fail loudly at resolve time
    providers.set(synthName, { ...base, name: synthName, model });
  }
  return synthName;
}

function newSession(ownerId: string): Session {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), version: '0', ownerPrincipalId: ownerId, status: 'active',
    contexts: [], messages: [], createdAt: now, updatedAt: now,
  };
}

function lastAssistantText(s: Session): string {
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

// Get day of week name for a given date in a specific timezone
function getDayOfWeek(now: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
  });
  return fmt.format(now);
}

// Format current time in the user's local timezone (YYYY-MM-DD HH:MM:SS TZ).
// Uses en-US locale with explicit component formatting to ensure consistent cross-platform output.
function formatLocalDateTime(now: Date, tz: string): string {
  // Extract date/time components; en-US locale provides reliable parts extraction regardless of runtime locale.
  const dtFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const part of dtFmt.formatToParts(now)) {
    parts[part.type] = part.value;
  }

  // Extract timezone abbreviation (e.g., "BST", "EST"). Falls back to tz ID if extraction fails.
  let tzAbbr = tz;
  const tzFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' });
  for (const part of tzFmt.formatToParts(now)) {
    if (part.type === 'timeZoneName') {
      tzAbbr = part.value;
      break;
    }
  }

  return `${parts['year']}-${parts['month']}-${parts['day']} ${parts['hour']}:${parts['minute']}:${parts['second']} ${tzAbbr}`;
}

// Generate agent system context block with current timestamp and timezone.
// Always returns a non-empty string containing structured time context.
function generateContextBlock(now: Date, tz: string): string {
  const isoTime = now.toISOString();
  const localTime = formatLocalDateTime(now, tz);
  const dayOfWeek = getDayOfWeek(now, tz);
  const context = {
    currentTime: isoTime,
    currentTimeLocal: localTime,
    timezone: tz,
    dayOfWeek,
  };
  return `[AGENT CONTEXT]\n${JSON.stringify(context, null, 2)}\n[END AGENT CONTEXT]`;
}

// Framing prepended to every agent turn's persona. Agents run under the same Eidan identity + full
// toolset as the chat surface, so a capable model reads its persona as a request to "Eidan the OS" and
// reaches for the orchestration tools (agent_create / agent_schedule / agent_delegate / jobs /
// procedures) — spinning up MORE agents or jobs instead of doing the task itself. This pins the model
// into the worker role. (The persona — the actual task/role — follows.)
const AGENT_FRAMING = [
  'You are an autonomous EIDAN AGENT executing ONE turn of your own loop. You are the WORKER that does the task, NOT the top-level assistant and NOT an orchestrator that hands work to others.',
  '',
  'Do the task described below YOURSELF, directly, using your available tools (memory, files, notifications, and whatever integrations the task needs). Then record anything worth keeping to memory and stop.',
  '',
  'Hard rules:',
  '- Do NOT create, update, schedule, relate, or delegate agents (agent_create, agent_update, agent_schedule, agent_relate, agent_delegate, …), and do NOT create jobs, routines, or procedures — UNLESS your task is explicitly about managing other agents. You are not a manager.',
  '- If your task is to produce something (a summary, a post, a reply, a decision, a saved memory), produce it yourself. Never spin up another agent, job, or procedure to do your own work.',
  '- Stay inside your role below. Don\'t reinterpret yourself as a larger system.',
  '',
  '— Your role and task —',
].join('\n');

// Run an agent's persona as a single turn under the owner's identity (so the conversation + memory
// writes persist as that user), using the agent's own provider. Returns the final assistant text and
// the conversation id (= the session id) so the caller can link the fire to its turn (agent_runs).
// Mirrors @eidandev/routines' runner, plus per-agent provider + conversation_id capture.
// timezone is used to generate current time context injected into the system framing.
export async function runAgentTurn(
  services: MatbotServices,
  userId: string,
  persona: string,
  provider: string,
  onConversation?: (conversationId: string) => Promise<void>,
  timeoutMs?: number,
  // External abort (graceful shutdown). Composed with the per-turn timeout below: whichever fires
  // first aborts the turn. matbot's runner persists the partial session before yielding `aborted`.
  extSignal?: AbortSignal,
  timezone: string,
): Promise<{ text: string; conversationId: string }> {
  const run = services.run;
  const sessions = services.sessions;
  if (!run || !sessions) throw new Error('agents: runner/sessions unavailable');
  const principal: Principal = { id: userId, type: 'user' };
  return runAs(principal, async () => {
    const session = newSession(userId);
    await sessions.set(session.id, session);
    // Tag the conversation as agent-origin before the turn runs (keeps it out of the human sidebar).
    if (onConversation) await onConversation(session.id);
    const ac = new AbortController();
    const onExt = (): void => ac.abort(extSignal?.reason ?? 'shutdown');
    if (extSignal) {
      if (extSignal.aborted) ac.abort(extSignal.reason ?? 'shutdown');
      else extSignal.addEventListener('abort', onExt, { once: true });
    }
    // Hard cap: a slow/stuck provider (e.g. a local model grinding on a big prompt) must not run
    // forever — abort the turn so it records a failure instead. The loop detaches fires, but the
    // timeout also bounds resource use per fire.
    const timer = timeoutMs && timeoutMs > 0 ? setTimeout(() => ac.abort(), timeoutMs) : undefined;
    try {
      const contextBlock = generateContextBlock(new Date(), timezone);
      const framing = [contextBlock, AGENT_FRAMING, persona].filter((s) => s.length > 0).join('\n\n');
      // contextBlock is positioned first in framing to serve as system-level context for the agent.
      // matbot's run.open does not expose a separate system parameter, so we prepend it as the first
      // text block (clearly marked with [AGENT CONTEXT] delimiters) to ensure it's foundational.
      const view = await run.open({
        sessionId: session.id, signal: ac.signal,
        content: [{ type: 'text', text: framing }], provider, principal,
      });
      let final: Session | undefined;
      for await (const ev of view.events) {
        if (ev.type === 'done') { final = ev.session; break; }
        if (ev.type === 'error') throw new Error(ev.error);
        if (ev.type === 'aborted') throw new Error(`aborted: ${ev.reason ?? 'timeout'}`);
      }
      return { text: final ? lastAssistantText(final) : '', conversationId: session.id };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (extSignal) extSignal.removeEventListener('abort', onExt);
    }
  });
}

// Preamble prepended to an agent's persona when re-firing it after a node restart interrupted its run.
// References the interrupted conversation so the agent can pick up where it left off (the partial turn
// was persisted before the abort) rather than starting blind.
export function continuationPreamble(conversationId: string | null): string {
  const ref = conversationId
    ? `Your previous run was interrupted mid-task; that conversation is \`${conversationId}\` (recall it for what you'd done so far). `
    : 'Your previous run was interrupted mid-task. ';
  return (
    `⏩ Resuming after a node restart (a deployment cut your last run short). ${ref}` +
    'Continue the task below from where you left off; avoid repeating work you had already completed.\n\n---\n\n'
  );
}

// Manual "run now" (test affordance, surfaced via POST /api/agents/:id/run). Starts the agent's turn
// under its OWN provider (+ model synthesis), tags the conversation as agent-origin, and returns the
// conversation id AS SOON AS it's created — the turn itself runs detached so the HTTP request doesn't
// block on a long agent run (and can't hit a proxy/gateway timeout). No agent_runs row is written: the
// run ledger is keyed by a trigger, and a manual test has none. Returns null if the agent is gone.
export async function fireAgentNow(
  services: MatbotServices,
  store: AgentsStore,
  agentId: string,
  userId: string,
  opts: { defaultProvider: string; turnTimeoutMs?: number },
): Promise<{ conversationId: string } | null> {
  const agent = await store.getAgent(agentId, userId);
  if (!agent) return null;
  const provider = effectiveProvider(services, agent.provider ?? opts.defaultProvider, agent.model);
  const timezone = await store.userTimeZone(userId);
  let resolveId: (id: string) => void;
  const idReady = new Promise<string>((r) => { resolveId = r; });
  void runAgentTurn(
    services, userId, agent.persona, provider,
    async (cid) => { await store.markAgentConversation(cid, agentId, agent.name); resolveId(cid); },
    opts.turnTimeoutMs,
    undefined,
    timezone,
  ).catch((e) => console.warn(`[agents] run-now "${agent.name}" failed:`, e instanceof Error ? e.message : e));
  return { conversationId: await idReady };
}

// Autonomous agent→agent delegation (the `agent_to_agent` relationship's runtime). Fire the target
// agent NOW with a delegated task prepended to its persona, under the same owner. Detached like
// fireAgentNow — returns the new conversation id as soon as it exists. A delegation chain is bounded
// by `depth` (a hard runaway backstop) + the caller's per-window rate cap; nothing here blocks on a
// human. Returns null if the target is gone or the depth cap is hit.
const MAX_DELEGATION_DEPTH = 6;
export async function fireAgentDelegate(
  services: MatbotServices,
  store: AgentsStore,
  toAgentId: string,
  task: string,
  userId: string,
  opts: { defaultProvider: string; turnTimeoutMs?: number | undefined; fromName?: string | undefined; depth?: number | undefined },
): Promise<{ conversationId: string } | null> {
  const depth = opts.depth ?? 1;
  if (depth > MAX_DELEGATION_DEPTH) {
    console.warn(`[agents] delegation depth cap (${MAX_DELEGATION_DEPTH}) hit — refusing to fire ${toAgentId}`);
    return null;
  }
  const agent = await store.getAgent(toAgentId, userId);
  if (!agent) return null;
  const provider = effectiveProvider(services, agent.provider ?? opts.defaultProvider, agent.model);
  const timezone = await store.userTimeZone(userId);
  const from = opts.fromName ? `from agent "${opts.fromName}" ` : '';
  const content =
    `## Delegated task ${from}(autonomous agent-to-agent hand-off, depth ${depth}/${MAX_DELEGATION_DEPTH})\n\n` +
    `${task}\n\n---\n\n${agent.persona}`;
  let resolveId: (id: string) => void;
  const idReady = new Promise<string>((r) => { resolveId = r; });
  void runAgentTurn(
    services, userId, content, provider,
    async (cid) => { await store.markAgentConversation(cid, toAgentId, agent.name); resolveId(cid); },
    opts.turnTimeoutMs,
    undefined,
    timezone,
  ).catch((e) => console.warn(`[agents] delegate to "${agent.name}" failed:`, e instanceof Error ? e.message : e));
  return { conversationId: await idReady };
}
