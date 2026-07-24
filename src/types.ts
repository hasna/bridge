export const CONFIG_VERSION = 1 as const;

export const CHANNEL_KINDS = ["telegram", "console", "webhook", "imessage"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const AGENT_KINDS = ["codewith", "claude", "aicopilot", "shell"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export interface BaseChannelConfig {
  id: string;
  kind: ChannelKind;
  label?: string;
  enabled?: boolean;
  /**
   * Agent that inbound messages auto-attach to when no session binding and no
   * matching route already exist for the conversation. Enables replies to work
   * without a manual `bridge sessions create/attach`: the first inbound message
   * lazily creates a durable session + binding, and later messages resume it.
   */
  defaultAgentId?: string;
}

export interface TelegramChannelConfig extends BaseChannelConfig {
  kind: "telegram";
  botTokenEnv?: string;
  defaultChatId?: string;
  allowedChatIds?: string[];
  allowAllChats?: boolean;
  pollTimeoutSeconds?: number;
  /** Outbound broadcast allowlist: channel/group chat ids this bridge may post to. */
  broadcastChatIds?: string[];
  /** Explicitly allow broadcasting to any chat id (mirrors allowAllChats for inbound). */
  allowAllBroadcasts?: boolean;
}

export interface ConsoleChannelConfig extends BaseChannelConfig {
  kind: "console";
}

export interface WebhookChannelConfig extends BaseChannelConfig {
  kind: "webhook";
  secretEnv?: string;
}

export interface IMessageChannelConfig extends BaseChannelConfig {
  kind: "imessage";
  account?: string;
  serviceName?: string;
  defaultHandle?: string;
  allowedHandles?: string[];
  allowAllHandles?: boolean;
  receiveMode?: "disabled" | "chat-db";
  chatDbPath?: string;
  pollLimit?: number;
}

export type ChannelConfig =
  | TelegramChannelConfig
  | ConsoleChannelConfig
  | WebhookChannelConfig
  | IMessageChannelConfig;

export interface ProfileConfig {
  id: string;
  agentKind: AgentKind;
  label?: string;
  authProfile?: string;
  cwd?: string;
  home?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Additional station env var names to pass through to the spawned agent on top
   * of the built-in allow-list. Entries may be exact names (`FOO`) or `PREFIX*`
   * globs (`GIT_*`). Credential-shaped names are still stripped defensively.
   */
  envPassthrough?: string[];
}

export interface AgentConfig {
  id: string;
  kind: AgentKind;
  label?: string;
  profileId?: string;
  /**
   * Ordered fallback profile ids used for automatic auth rotation when the
   * active profile hits usage/quota/auth exhaustion. The rotation pool is
   * [profileId, ...fallbackProfileIds]. Rotation switches only the billing
   * account and resumes the SAME codewith thread under it (shared thread store),
   * so conversation context carries across the switch.
   */
  fallbackProfileIds?: string[];
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Extra station env var names to pass through (see {@link ProfileConfig.envPassthrough}). */
  envPassthrough?: string[];
  timeoutMs?: number;
}

export interface RouteMatch {
  chatIds?: string[];
  textRegex?: string;
}

export interface RouteConfig {
  id: string;
  fromChannel: string;
  toAgent: string;
  responseChannel?: string;
  enabled?: boolean;
  match?: RouteMatch;
}

export interface BridgeConfig {
  version: typeof CONFIG_VERSION;
  channels: Record<string, ChannelConfig>;
  profiles: Record<string, ProfileConfig>;
  agents: Record<string, AgentConfig>;
  routes: RouteConfig[];
}

export interface BridgeMessage {
  id: string;
  channelId: string;
  text: string;
  chatId?: string;
  threadId?: string;
  responseTargetId?: string;
  from?: string;
  receivedAt: string;
  raw?: unknown;
}

export type BridgeSessionStatus = "active" | "paused" | "closed";
export type AgentSessionMode = "durable" | "compatibility";

export interface AgentSessionRef {
  kind: AgentKind;
  mode: AgentSessionMode;
  /**
   * The single, auth-independent codewith `thread_id` for this conversation.
   * codewith threads/rollouts live under a shared `CODEWITH_HOME/sessions` store
   * keyed only by thread id — never by billing account — so this one id is
   * resumable by ANY auth profile pointed at the same home. Rotating the billing
   * account on exhaustion keeps this id; it does NOT fork per profile.
   */
  refId?: string;
  /**
   * The codewith auth profile (billing account) currently active for this
   * conversation. Switching it on rotation only changes who pays for the turn;
   * {@link refId} (the thread) is unchanged, so context carries across the switch.
   */
  authProfile?: string;
  createdAt?: string;
  updatedAt?: string;
  detail?: string;
}

export interface BridgeSession {
  id: string;
  agentId: string;
  profileId?: string;
  cwd?: string;
  title?: string;
  status: BridgeSessionStatus;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
  agentSession?: AgentSessionRef;
}

export interface BridgeBinding {
  id: string;
  channelId: string;
  conversationId: string;
  activeSessionId: string;
  defaultSessionId?: string;
  createdAt: string;
  updatedAt: string;
  authorization?: {
    chatId?: string;
    from?: string;
  };
}

export type LedgerStatus = "processing" | "agent_completed" | "delivered" | "skipped" | "unauthorized" | "failed" | "dead_letter";

export interface MessageLedgerEntry {
  id: string;
  channelId: string;
  messageId: string;
  conversationId?: string;
  sessionId?: string;
  status: LedgerStatus;
  attempts: number;
  firstSeenAt: string;
  updatedAt: string;
  terminalAt?: string;
  error?: string;
  responseText?: string;
  deliveredResponse?: boolean;
  agentExitCode?: number | null;
  agentTimedOut?: boolean;
}

export interface AgentRunInput {
  message: BridgeMessage;
  route: RouteConfig;
  session?: BridgeSession;
}

export interface AgentRunResult {
  agentId: string;
  command: string[];
  cwd?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /**
   * Isolated reply text for the user. For durable codewith runs stdout is JSONL
   * event output and must NOT be shown to the user; the reply comes from the
   * agent's last-message file (or the parsed final assistant event) instead.
   */
  replyText?: string;
  /** True when stdout is structured (JSONL) and unsafe to relay as a reply. */
  stdoutStructured?: boolean;
  /** Provider (codewith) session id created/resumed by this run, if any. */
  providerSessionId?: string;
  /** Auth profile this run executed under (the final one, after any rotation). */
  authProfile?: string;
  /** True when the run hit a usage/quota/auth exhaustion signal. */
  exhausted?: boolean;
  /** True when the adapter rotated to a different auth profile during this turn. */
  rotated?: boolean;
  /**
   * True when the turn ran on a fresh codewith session that did not carry the
   * conversation's prior context — because rotation switched to another profile
   * (durable sessions are not resumable across profiles) or a stale session was
   * self-healed. Callers should tell the user their context was reset.
   */
  contextReset?: boolean;
  /** True when a resumed session id was gone and the turn was retried fresh. */
  staleSessionHealed?: boolean;
}

export interface RoutedMessageResult {
  route: RouteConfig;
  agent: AgentRunResult;
  deliveredResponse?: boolean;
}

export interface SessionMessageResult {
  kind: "session";
  session?: BridgeSession;
  binding?: BridgeBinding;
  conversationId?: string;
  agent?: AgentRunResult;
  deliveredResponse?: boolean;
  status: "delivered" | "no_session" | "paused" | "closed" | "unauthorized" | "no_output" | "failed";
  message?: string;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface DoctorReport {
  ok: boolean;
  configPath: string;
  checks: DoctorCheck[];
}

// ─── Outbound broadcast (distribution apps plan) ──────────────────────────────

export type BroadcastPostStatus = "sent" | "failed" | "skipped";

export interface BroadcastPost {
  /** Target chat id (Telegram channel/group) or "console". */
  target: string;
  status: BroadcastPostStatus;
  /** Provider message id when the post was accepted (e.g. Telegram message_id). */
  messageId?: string;
  /** Failure or skip explanation. */
  detail?: string;
  sentAt?: string;
}

export interface BroadcastResult {
  id: string;
  channelId: string;
  channelKind: ChannelKind;
  text: string;
  requestedAt: string;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  posts: BroadcastPost[];
}
