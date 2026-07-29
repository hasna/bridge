import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type {
  AgentRunResult,
  BridgeBinding,
  BridgeConfig,
  BridgeMessage,
  BridgeSession,
  ChannelConfig,
  MessageLedgerEntry,
  SessionMessageResult,
} from "../types.js";
import type { BridgeState } from "./state.js";
import { closeAgentSession, createAgentSessionRef, extractCodewithErrorMessage, filterAgentLogNoise, recordDurableSession, resolveAgent, runAgent, sendAgentSessionMessage } from "./agents.js";
import { imessageHandleAllowed, sendIMessage } from "./imessage.js";
import { routeMessage } from "./router.js";
import { sendTelegramMessage, telegramChatAllowed, telegramToken } from "./telegram.js";

export interface CreateSessionInput {
  id?: string;
  agentId: string;
  title?: string;
  cwd?: string;
}

export interface AttachSessionInput {
  sessionId: string;
  channelId: string;
  conversation: string;
  makeDefault?: boolean;
  authorization?: BridgeBinding["authorization"];
}

export interface SessionMessageOptions {
  run?: typeof runAgent;
  sendTelegram?: typeof sendTelegramMessage;
  writeConsole?: ((text: string) => void) | false;
  respondOnNoSession?: boolean;
  fallbackToRoutes?: boolean;
  persistState?: (state: BridgeState) => Promise<void>;
  beforeDeliver?: (agent: AgentRunResult, responseText: string) => Promise<void>;
}

export interface DispatchMessageResult {
  message: BridgeMessage;
  session?: SessionMessageResult;
  routes?: Awaited<ReturnType<typeof routeMessage>>;
  ledger?: MessageLedgerEntry;
}

/** Ledger statuses that are final: a message in one of these is never reprocessed. */
export const TERMINAL_LEDGER_STATUSES: readonly MessageLedgerEntry["status"][] = [
  "delivered", "skipped", "unauthorized", "dead_letter",
];

export function isTerminalLedgerStatus(status: MessageLedgerEntry["status"]): boolean {
  return TERMINAL_LEDGER_STATUSES.includes(status);
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * User-visible note prepended ONLY when the conversation's codewith thread was
 * genuinely unrecoverable — a self-healed stale session where the stored thread
 * was gone/expired and a brand-new one had to be started. Normal auth-profile
 * rotation on exhaustion does NOT set this: rotation resumes the same shared
 * thread under a different billing account, so context carries over and claiming
 * a reset would be misleading.
 */
export const CONTEXT_RESET_NOTE =
  "ℹ️ Note: your previous session could no longer be resumed, so I started a new one. Earlier conversation context was not carried over.";

/**
 * The user-facing reply text. Durable codewith runs emit JSONL on stdout, which
 * must never be relayed to the user; the isolated reply comes from replyText.
 * When the run genuinely reset context (stale-session self-heal only) a note is
 * prepended so the reset is visible to the user; normal rotation carries context
 * and prepends nothing.
 */
function agentReplyText(agent: AgentRunResult): string {
  const base = agent.replyText !== undefined
    ? agent.replyText.trim()
    : agent.stdoutStructured
      ? ""
      : agent.stdout.trim();
  if (base && agent.contextReset) return `${CONTEXT_RESET_NOTE}\n\n${base}`;
  return base;
}

function truncateDetail(text: string, max = 700): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * A CLEAR failure explanation for a failed agent run: prefers the structured
 * codewith error event (unwrapping nested provider errors), then stderr with
 * non-fatal tool log noise (e.g. shell_snapshot validation warnings) stripped,
 * then any reply text, then a generic exit/timeout summary. This is what gets
 * surfaced to the user instead of a silent dead-letter.
 */
export function agentFailureText(agent: AgentRunResult): string {
  const structured = extractCodewithErrorMessage(agent.stdout) || extractCodewithErrorMessage(agent.stderr);
  const stderrText = filterAgentLogNoise(agent.stderr);
  const detail = structured
    || stderrText
    || agentReplyText(agent)
    || (agent.timedOut ? "the agent run timed out" : `the agent exited with code ${agent.exitCode}`);
  return truncateDetail(detail);
}

/**
 * Sends an explicit error reply for a dead-lettered message, so a repeatedly
 * failing agent run surfaces to the sender instead of dying silently in the
 * ledger. Delivery reuses the normal (allow-listed) response path.
 */
export async function notifyDeadLetter(
  config: BridgeConfig,
  message: BridgeMessage,
  entry: MessageLedgerEntry,
  options: SessionMessageOptions = {},
): Promise<boolean> {
  const reason = entry.error?.trim() || "the agent run kept failing";
  const text = `⚠️ I could not process that message (${entry.attempts} attempt${entry.attempts === 1 ? "" : "s"}): ${truncateDetail(reason)}`;
  return deliverResponse(config, message, text, options);
}

function newSessionId(): string {
  return `ses_${randomUUID()}`;
}

export function normalizeConversationId(channel: ChannelConfig, conversation: string): string {
  if (conversation.includes(":") && conversation.startsWith(`${channel.kind}:`)) return conversation;
  if (channel.kind === "telegram") return `telegram:${channel.id}:${conversation}`;
  if (channel.kind === "imessage") return `imessage:${channel.id}:${conversation}`;
  return `${channel.kind}:${channel.id}:${conversation || "default"}`;
}

export function messageConversationId(config: BridgeConfig, message: BridgeMessage): string | undefined {
  const channel = config.channels[message.channelId];
  if (!channel) return undefined;
  if (channel.kind === "telegram") {
    if (!message.chatId) return undefined;
    return normalizeConversationId(channel, message.threadId ? `${message.chatId}:${message.threadId}` : message.chatId);
  }
  if (channel.kind === "imessage") {
    const conversation = message.chatId || message.from;
    return conversation ? normalizeConversationId(channel, conversation) : undefined;
  }
  return normalizeConversationId(channel, message.chatId || message.from || "default");
}

export function bindingId(channelId: string, conversationId: string): string {
  return `${channelId}::${conversationId}`;
}

export function ledgerId(message: BridgeMessage): string {
  return `${message.channelId}::${message.id}`;
}

export function createBridgeSession(config: BridgeConfig, state: BridgeState, input: CreateSessionInput): BridgeSession {
  const { agent, profile } = resolveAgent(config, input.agentId);
  const timestamp = nowIso();
  const session: BridgeSession = {
    id: input.id || newSessionId(),
    agentId: agent.id,
    profileId: agent.profileId,
    cwd: input.cwd || agent.cwd || profile?.cwd,
    title: input.title,
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
    agentSession: createAgentSessionRef(config, agent.id),
  };
  state.sessions[session.id] = session;
  return session;
}

export function getBridgeSession(state: BridgeState, sessionId: string): BridgeSession {
  const session = state.sessions[sessionId];
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  return session;
}

export function listBridgeSessions(state: BridgeState): BridgeSession[] {
  return Object.values(state.sessions).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function updateBridgeSessionStatus(state: BridgeState, sessionId: string, status: BridgeSession["status"]): BridgeSession {
  const session = getBridgeSession(state, sessionId);
  if (status === "closed") closeAgentSession(session);
  session.status = status;
  session.updatedAt = nowIso();
  return session;
}

export function attachBridgeSession(config: BridgeConfig, state: BridgeState, input: AttachSessionInput): BridgeBinding {
  const channel = config.channels[input.channelId];
  if (!channel) throw new Error(`Channel not found: ${input.channelId}`);
  const session = getBridgeSession(state, input.sessionId);
  if (session.status === "closed") throw new Error(`Cannot attach closed session: ${session.id}`);
  const conversationId = normalizeConversationId(channel, input.conversation);
  const id = bindingId(channel.id, conversationId);
  const existing = state.bindings[id];
  const timestamp = nowIso();
  const binding: BridgeBinding = {
    id,
    channelId: channel.id,
    conversationId,
    activeSessionId: session.id,
    defaultSessionId: input.makeDefault ? session.id : existing?.defaultSessionId,
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
    authorization: input.authorization || existing?.authorization || (channel.kind === "telegram" ? { chatId: input.conversation.split(":")[0] } : undefined),
  };
  state.bindings[id] = binding;
  return binding;
}

export function detachBridgeBinding(config: BridgeConfig, state: BridgeState, channelId: string, conversation: string): BridgeBinding | undefined {
  const channel = config.channels[channelId];
  if (!channel) throw new Error(`Channel not found: ${channelId}`);
  const conversationId = normalizeConversationId(channel, conversation);
  const id = bindingId(channel.id, conversationId);
  const existing = state.bindings[id];
  delete state.bindings[id];
  return existing;
}

export function findBridgeBinding(config: BridgeConfig, state: BridgeState, message: BridgeMessage): BridgeBinding | undefined {
  const conversationId = messageConversationId(config, message);
  if (!conversationId) return undefined;
  return state.bindings[bindingId(message.channelId, conversationId)];
}

/**
 * Resolves the agent an inbound conversation should auto-attach to when it has no
 * binding yet. Preference order:
 *   1. the channel's explicit `defaultAgentId`;
 *   2. the sole configured `codewith` agent (the station's coding agent).
 *
 * (2) is what makes an inbound reply from an already-allowlisted chat (e.g. the
 * owner chat) route to an agent instead of the "no session" help text even when
 * the operator never set `defaultAgentId` on the channel. Resolution is
 * config-driven — it never invents an agent id — so an ambiguous config (several
 * codewith agents, none defaulted) still returns `undefined` rather than guessing.
 * It deliberately does not fall back to non-codewith agents (e.g. a shell agent),
 * so auto-provisioning stays scoped to the intended coding-agent use case.
 */
export function resolveAutoAgentId(config: BridgeConfig, channel: ChannelConfig): string | undefined {
  if (channel.defaultAgentId) return channel.defaultAgentId;
  const codewith = Object.keys(config.agents).filter((id) => config.agents[id]?.kind === "codewith");
  return codewith.length === 1 ? codewith[0] : undefined;
}

/**
 * Lazily create a session + binding for a conversation that has none yet, using
 * the agent resolved by {@link resolveAutoAgentId}. This is what makes inbound
 * replies work end to end without an operator running `bridge sessions
 * create/attach` first: the first message from a chat provisions a durable
 * session, and later messages resume it (same conversationId -> same binding ->
 * same session).
 *
 * Returns the existing binding when one is already present, a freshly created
 * binding when an auto-provision agent resolves, or `undefined` when there is no
 * conversation id / no resolvable agent (callers fall through to routes or the
 * no-session help text, preserving legacy behaviour).
 */
export function ensureConversationBinding(
  config: BridgeConfig,
  state: BridgeState,
  message: BridgeMessage,
): BridgeBinding | undefined {
  const conversationId = messageConversationId(config, message);
  if (!conversationId) return undefined;
  const existing = state.bindings[bindingId(message.channelId, conversationId)];
  if (existing) return existing;
  const channel = config.channels[message.channelId];
  if (!channel) return undefined;
  // An explicit-but-missing defaultAgentId is a config error: surface it loudly
  // rather than silently falling back to an inferred agent.
  if (channel.defaultAgentId && !config.agents[channel.defaultAgentId]) {
    throw new Error(`Channel ${channel.id} defaultAgentId not found: ${channel.defaultAgentId}`);
  }
  const agentId = resolveAutoAgentId(config, channel);
  if (!agentId) return undefined;
  const session = createBridgeSession(config, state, {
    agentId,
    title: `auto:${conversationId}`,
  });
  const authorization = channel.kind === "telegram"
    ? (message.chatId ? { chatId: message.chatId } : undefined)
    : channel.kind === "imessage"
      ? (message.from || message.chatId ? { from: message.from, chatId: message.chatId } : undefined)
      : undefined;
  return attachBridgeSession(config, state, {
    sessionId: session.id,
    channelId: message.channelId,
    conversation: conversationId,
    makeDefault: true,
    authorization,
  });
}

function noSessionText(channelId: string, conversationId?: string): string {
  return [
    "No bridge session is attached to this conversation.",
    "Create and attach one locally:",
    "bridge sessions create --agent <agent-id>",
    `bridge sessions attach <session-id> --channel ${channelId}${conversationId ? ` --conversation ${conversationId}` : " --conversation <conversation-id>"}`,
  ].join("\n");
}

async function deliverResponse(
  config: BridgeConfig,
  message: BridgeMessage,
  text: string,
  options: SessionMessageOptions,
): Promise<boolean> {
  const channel = config.channels[message.channelId];
  if (!text || !channel || channel.enabled === false) return false;
  if (channel.kind === "telegram" && message.chatId) {
    if (!telegramChatAllowed(channel, message.chatId)) return false;
    await (options.sendTelegram || sendTelegramMessage)(telegramToken(channel), message.chatId, text);
    return true;
  }
  if (channel.kind === "console") {
    if (options.writeConsole !== false) (options.writeConsole || console.log)(text);
    return true;
  }
  if (channel.kind === "imessage" && message.chatId) {
    const allowedIdentity = message.from || (message.chatId.startsWith("chat:") ? undefined : message.chatId);
    if (!imessageHandleAllowed(channel, allowedIdentity)) return false;
    await sendIMessage(channel, message.responseTargetId || message.chatId, text, { allowChatTarget: Boolean(message.responseTargetId?.startsWith("chat:") || message.chatId.startsWith("chat:")) });
    return true;
  }
  return false;
}

async function deliverStoredResponse(
  config: BridgeConfig,
  state: BridgeState,
  binding: BridgeBinding,
  message: BridgeMessage,
  entry: MessageLedgerEntry,
  options: SessionMessageOptions,
): Promise<SessionMessageResult> {
  const session = getBridgeSession(state, binding.activeSessionId);
  const responseText = entry.responseText || "";
  const deliveredResponse = responseText ? await deliverResponse(config, message, responseText, options) : false;
  completeLedger(entry, "delivered", session.id);
  entry.deliveredResponse = deliveredResponse;
  return {
    kind: "session",
    session,
    binding,
    conversationId: binding.conversationId,
    deliveredResponse,
    status: responseText ? "delivered" : "no_output",
  };
}

function channelAuthorized(config: BridgeConfig, message: BridgeMessage): boolean {
  const channel = config.channels[message.channelId];
  if (!channel || channel.enabled === false) return false;
  if (channel.kind === "telegram") return telegramChatAllowed(channel, message.chatId);
  if (channel.kind === "imessage") return imessageHandleAllowed(channel, message.from || (message.chatId?.startsWith("chat:") ? undefined : message.chatId));
  return true;
}

function bindingAuthorized(binding: BridgeBinding, message: BridgeMessage): boolean {
  if (binding.authorization?.chatId && binding.authorization.chatId !== message.chatId) return false;
  if (binding.authorization?.from && binding.authorization.from !== message.from) return false;
  return true;
}

/**
 * In-flight turn per bridge session, so a session processes ONE message at a
 * time. Nothing else serialises this: `bridge_session_send` /
 * `bridge_session_route_message` are MCP tools and the MCP SDK does not
 * serialise tool calls, so two messages for the same session could run
 * concurrently. Both turns would then execute
 * `codewith exec resume <same thread id>` against the SAME rollout file in the
 * shared codewith home (the very thing the shared thread store exists for) and
 * race to write the session ref back — an interleaved codewith thread and a lost
 * thread id.
 */
const sessionTurnQueues = new Map<string, Promise<unknown>>();

/**
 * Session ids whose turn lock is already held by the current async context.
 * Acquisition must be re-entrant: callers that own state persistence hold the
 * lock across their whole load -> send -> save (see
 * {@link withSessionStateTurn}), and the send path takes the same lock
 * internally — a second non-re-entrant acquire would queue behind itself and
 * wedge the conversation forever.
 */
const heldSessionLocks = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * Runs `fn` after any turn already queued for `sessionId`. Predecessor failures
 * never poison the queue, and the map entry is dropped once the tail settles, so
 * a failing agent run cannot deadlock the conversation.
 */
export function withSessionTurnLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const held = heldSessionLocks.getStore();
  if (held?.has(sessionId)) return fn();
  const owned = new Set(held || []).add(sessionId);
  const previous = sessionTurnQueues.get(sessionId) || Promise.resolve();
  const run = previous.then(() => heldSessionLocks.run(owned, fn));
  const tail = run.then(() => undefined, () => undefined);
  sessionTurnQueues.set(sessionId, tail);
  void tail.then(() => {
    if (sessionTurnQueues.get(sessionId) === tail) sessionTurnQueues.delete(sessionId);
  });
  return run;
}

/** Reads and writes the persisted bridge state a turn operates on. */
export interface SessionStateStore {
  load: () => Promise<BridgeState>;
  save: (state: BridgeState) => Promise<void>;
}

/**
 * Runs one turn as a single critical section: the state snapshot is both READ
 * and WRITTEN inside the session turn lock.
 *
 * Callers that own persistence — the `bridge_session_send` /
 * `bridge_session_route_message` MCP tools — must use this instead of
 * load -> send -> save wrapped around the lock. Each tool invocation parses its
 * own state object, so a turn that loaded before its predecessor ran would enter
 * the lock holding a pre-predecessor snapshot: it would resume nothing, fork a
 * SECOND codewith thread for the conversation, and its trailing save would
 * clobber the thread id (plus the ledger entry, binding and offsets) the first
 * turn recorded. Serialising the agent run alone does not prevent that.
 *
 * `sessionId` is undefined when the conversation has no binding yet: there is no
 * session to serialise on, and the turn's own {@link sendBridgeSessionMessage}
 * takes the lock once one exists.
 */
export async function withSessionStateTurn<T>(
  sessionId: string | undefined,
  store: SessionStateStore,
  fn: (state: BridgeState) => Promise<T>,
): Promise<T> {
  const turn = async (): Promise<T> => {
    const state = await store.load();
    const result = await fn(state);
    await store.save(state);
    return result;
  };
  return sessionId ? withSessionTurnLock(sessionId, turn) : turn();
}

/**
 * The session a message would be dispatched to, resolved from its conversation
 * binding. Callers that own persistence need this key BEFORE they read state
 * inside the lock, so the whole load -> dispatch -> save is one critical
 * section; `undefined` means the conversation has no binding yet.
 */
export function messageSessionId(
  config: BridgeConfig,
  state: BridgeState,
  message: BridgeMessage,
): string | undefined {
  return findBridgeBinding(config, state, message)?.activeSessionId;
}

export function sendBridgeSessionMessage(
  config: BridgeConfig,
  state: BridgeState,
  sessionId: string,
  message: BridgeMessage,
  options: SessionMessageOptions = {},
): Promise<SessionMessageResult> {
  // The session is read INSIDE the lock, so a queued turn sees the thread id and
  // auth profile the preceding turn recorded — but only as far as `state` is the
  // same object the preceding turn mutated. A caller that parses its own
  // snapshot per invocation must take the lock around its load AND its save via
  // {@link withSessionStateTurn}, or the queued turn still enters with a
  // pre-predecessor view.
  return withSessionTurnLock(sessionId, () => runBridgeSessionTurn(config, state, sessionId, message, options));
}

async function runBridgeSessionTurn(
  config: BridgeConfig,
  state: BridgeState,
  sessionId: string,
  message: BridgeMessage,
  options: SessionMessageOptions,
): Promise<SessionMessageResult> {
  const session = getBridgeSession(state, sessionId);
  if (session.status === "paused") return { kind: "session", session, status: "paused", message: "Session is paused" };
  if (session.status === "closed") return { kind: "session", session, status: "closed", message: "Session is closed" };

  const agent = await sendAgentSessionMessage(config, session, message, { run: options.run });
  const timestamp = nowIso();
  session.lastMessageAt = timestamp;
  session.updatedAt = timestamp;
  const ref = session.agentSession;
  if (ref) ref.updatedAt = timestamp;
  // An EARLIER turn dropped a provably gone thread and could not tell the user
  // (it failed, so it produced no reply to carry the notice). Read the debt
  // before recordDurableSession, which is what may raise it on THIS turn.
  const resetDebt = Boolean(ref?.contextResetPending);
  // Persist any durable provider session id even on failure, so the next
  // message resumes the same codewith session rather than starting over.
  recordDurableSession(session, agent);

  // Only a timeout or non-zero exit fails a run — stderr warnings (e.g.
  // shell_snapshot validation noise) never do.
  if (agent.timedOut || (agent.exitCode !== null && agent.exitCode !== 0)) {
    return {
      kind: "session",
      session,
      agent,
      deliveredResponse: false,
      status: "failed",
      message: agentFailureText(agent),
    };
  }

  // This turn succeeded, so it is the first one able to deliver the notice.
  if (resetDebt) agent.contextReset = true;
  const responseText = agentReplyText(agent);
  // Settle the debt only once a reply actually carries the note. The note is
  // baked into `responseText`, which the ledger stores and re-delivers, so a
  // failed send still surfaces it on redelivery rather than losing it.
  if (responseText && ref?.contextResetPending) delete ref.contextResetPending;
  await options.beforeDeliver?.(agent, responseText);
  const deliveredResponse = responseText ? await deliverResponse(config, message, responseText, options) : false;
  return {
    kind: "session",
    session,
    agent,
    deliveredResponse,
    status: responseText ? "delivered" : "no_output",
  };
}

export async function routeSessionMessage(
  config: BridgeConfig,
  state: BridgeState,
  message: BridgeMessage,
  options: SessionMessageOptions = {},
): Promise<SessionMessageResult> {
  const channel = config.channels[message.channelId];
  if (!channel || channel.enabled === false) {
    return { kind: "session", status: "unauthorized", message: `Channel not enabled: ${message.channelId}` };
  }
  if (!channelAuthorized(config, message)) {
    return { kind: "session", status: "unauthorized", message: "Message is not authorized for this channel" };
  }
  const conversationId = messageConversationId(config, message);
  const binding = conversationId ? state.bindings[bindingId(message.channelId, conversationId)] : undefined;
  if (!binding) {
    const text = noSessionText(message.channelId, conversationId);
    if (options.respondOnNoSession !== false) await deliverResponse(config, message, text, options);
    return { kind: "session", conversationId, status: "no_session", message: text };
  }
  if (!bindingAuthorized(binding, message)) {
    return { kind: "session", binding, conversationId, status: "unauthorized", message: "Message does not match binding authorization" };
  }
  const result = await sendBridgeSessionMessage(config, state, binding.activeSessionId, message, options);
  return { ...result, binding, conversationId };
}

function beginLedger(state: BridgeState, message: BridgeMessage, conversationId?: string): { entry: MessageLedgerEntry; shouldProcess: boolean } {
  const id = ledgerId(message);
  const existing = state.messageLedger[id];
  if (existing && isTerminalLedgerStatus(existing.status)) {
    return { entry: existing, shouldProcess: false };
  }
  const timestamp = nowIso();
  const entry: MessageLedgerEntry = existing || {
    id,
    channelId: message.channelId,
    messageId: message.id,
    conversationId,
    status: "processing",
    attempts: 0,
    firstSeenAt: timestamp,
    updatedAt: timestamp,
  };
  if (entry.status !== "agent_completed") entry.status = "processing";
  entry.attempts += 1;
  entry.conversationId = conversationId || entry.conversationId;
  entry.updatedAt = timestamp;
  delete entry.error;
  state.messageLedger[id] = entry;
  return { entry, shouldProcess: true };
}

function completeLedger(entry: MessageLedgerEntry, status: MessageLedgerEntry["status"], sessionId?: string, error?: string): MessageLedgerEntry {
  const timestamp = nowIso();
  entry.status = status;
  entry.sessionId = sessionId || entry.sessionId;
  entry.updatedAt = timestamp;
  if (isTerminalLedgerStatus(status)) entry.terminalAt = timestamp;
  if (error) entry.error = error;
  return entry;
}

function recordAgentCompleted(entry: MessageLedgerEntry, sessionId: string | undefined, agent: AgentRunResult, responseText: string): MessageLedgerEntry {
  const timestamp = nowIso();
  entry.status = "agent_completed";
  entry.sessionId = sessionId || entry.sessionId;
  entry.responseText = responseText;
  entry.agentExitCode = agent.exitCode;
  entry.agentTimedOut = agent.timedOut;
  entry.updatedAt = timestamp;
  delete entry.error;
  return entry;
}

export async function dispatchMessageWithSessions(
  config: BridgeConfig,
  state: BridgeState,
  message: BridgeMessage,
  options: SessionMessageOptions = {},
): Promise<DispatchMessageResult> {
  const conversationId = messageConversationId(config, message);
  const { entry, shouldProcess } = beginLedger(state, message, conversationId);
  if (!shouldProcess) return { message, ledger: entry };
  await options.persistState?.(state);

  try {
    let binding = conversationId ? state.bindings[bindingId(message.channelId, conversationId)] : undefined;
    if (!binding && channelAuthorized(config, message)) {
      const created = ensureConversationBinding(config, state, message);
      if (created) {
        binding = created;
        await options.persistState?.(state);
      }
    }
    if (binding) {
      if (!bindingAuthorized(binding, message)) {
        const session: SessionMessageResult = {
          kind: "session",
          binding,
          conversationId,
          status: "unauthorized",
          message: "Message does not match binding authorization",
        };
        completeLedger(entry, "unauthorized");
        return { message, session, ledger: entry };
      }
      if (entry.status === "agent_completed") {
        const session = await deliverStoredResponse(config, state, binding, message, entry, options);
        return { message, session, ledger: entry };
      }
      const session = await routeSessionMessage(config, state, message, {
        ...options,
        beforeDeliver: async (agent, responseText) => {
          recordAgentCompleted(entry, binding.activeSessionId, agent, responseText);
          await options.persistState?.(state);
          await options.beforeDeliver?.(agent, responseText);
        },
      });
      if (session.status === "failed") {
        completeLedger(entry, "failed", session.session?.id, session.message);
        throw new Error(session.message || "Agent session failed");
      }
      const terminal = session.status === "unauthorized" ? "unauthorized" : session.status === "delivered" || session.status === "no_output" ? "delivered" : "skipped";
      completeLedger(entry, terminal, session.session?.id);
      entry.deliveredResponse = session.deliveredResponse;
      return { message, session, ledger: entry };
    }

    if (options.fallbackToRoutes) {
      const routes = await routeMessage(config, message, options);
      if (routes.length) {
        completeLedger(entry, "delivered");
        return { message, routes, ledger: entry };
      }
    }

    const session = await routeSessionMessage(config, state, message, options);
    const status = session.status === "unauthorized" ? "unauthorized" : "skipped";
    completeLedger(entry, status, session.session?.id);
    return { message, session, ledger: entry };
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    if (entry.status === "agent_completed") {
      entry.error = messageText;
      entry.updatedAt = nowIso();
    } else {
      completeLedger(entry, "failed", undefined, messageText);
    }
    throw err;
  }
}
