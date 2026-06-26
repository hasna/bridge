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
}

export interface TelegramChannelConfig extends BaseChannelConfig {
  kind: "telegram";
  botTokenEnv?: string;
  defaultChatId?: string;
  allowedChatIds?: string[];
  allowAllChats?: boolean;
  pollTimeoutSeconds?: number;
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
}

export interface AgentConfig {
  id: string;
  kind: AgentKind;
  label?: string;
  profileId?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
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
  refId?: string;
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

export type LedgerStatus = "processing" | "agent_completed" | "delivered" | "skipped" | "unauthorized" | "failed";

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
