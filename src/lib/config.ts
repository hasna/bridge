import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { CONFIG_VERSION, type AgentConfig, type AgentWorkspaceConfig, type BridgeConfig, type ChannelConfig, type ProfileConfig, type RouteConfig } from "../types.js";
import { defaultConfigPath } from "./paths.js";

const REDACTED_VALUE = "[redacted]";

const channelSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1),
    kind: z.literal("telegram"),
    label: z.string().optional(),
    enabled: z.boolean().optional(),
    defaultAgentId: z.string().optional(),
    botTokenEnv: z.string().optional(),
    defaultChatId: z.string().optional(),
    allowedChatIds: z.array(z.string()).optional(),
    allowAllChats: z.boolean().optional(),
    pollTimeoutSeconds: z.number().int().positive().max(50).optional(),
    broadcastChatIds: z.array(z.string()).optional(),
    allowAllBroadcasts: z.boolean().optional(),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("console"),
    label: z.string().optional(),
    enabled: z.boolean().optional(),
    defaultAgentId: z.string().optional(),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("webhook"),
    label: z.string().optional(),
    enabled: z.boolean().optional(),
    defaultAgentId: z.string().optional(),
    secretEnv: z.string().optional(),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("imessage"),
    label: z.string().optional(),
    enabled: z.boolean().optional(),
    defaultAgentId: z.string().optional(),
    account: z.string().optional(),
    serviceName: z.string().optional(),
    defaultHandle: z.string().optional(),
    allowedHandles: z.array(z.string()).optional(),
    allowAllHandles: z.boolean().optional(),
    receiveMode: z.enum(["disabled", "chat-db"]).optional(),
    chatDbPath: z.string().optional(),
    pollLimit: z.number().int().positive().max(500).optional(),
  }),
]);

const envSchema = z.record(z.string(), z.string());

const profileSchema = z.object({
  id: z.string().min(1),
  agentKind: z.enum(["codewith", "claude", "aicopilot", "shell"]),
  label: z.string().optional(),
  authProfile: z.string().optional(),
  cwd: z.string().optional(),
  home: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: envSchema.optional(),
  envPassthrough: z.array(z.string()).optional(),
});

const agentWorkspaceSchema = z.object({
  projectId: z.string().optional(),
  path: z.string().optional(),
  channel: z.string().optional(),
  channelProvisionedAt: z.string().optional(),
  provisionedAt: z.string().optional(),
});

const agentSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["codewith", "claude", "aicopilot", "shell"]),
  label: z.string().optional(),
  profileId: z.string().optional(),
  fallbackProfileIds: z.array(z.string()).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: envSchema.optional(),
  envPassthrough: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  workspace: agentWorkspaceSchema.optional(),
});

const routeSchema = z.object({
  id: z.string().min(1),
  fromChannel: z.string().min(1),
  toAgent: z.string().min(1),
  responseChannel: z.string().optional(),
  enabled: z.boolean().optional(),
  match: z.object({
    chatIds: z.array(z.string()).optional(),
    // Validated here so an unusable pattern can never be persisted. Compiling it
    // lazily inside matchingRoutes throws a raw SyntaxError on every inbound
    // message, and because the poll offset only advances on a terminal outcome
    // that wedges the channel permanently.
    textRegex: z.string().optional().refine(
      (value) => {
        if (value === undefined) return true;
        try {
          new RegExp(value);
          return true;
        } catch {
          return false;
        }
      },
      { message: "textRegex must be a valid regular expression" },
    ),
  }).optional(),
});

const configSchema = z.object({
  version: z.literal(CONFIG_VERSION),
  channels: z.record(channelSchema),
  profiles: z.record(profileSchema),
  agents: z.record(agentSchema),
  routes: z.array(routeSchema),
});

export function emptyConfig(): BridgeConfig {
  return {
    version: CONFIG_VERSION,
    channels: {},
    profiles: {},
    agents: {},
    routes: [],
  };
}

export function parseConfig(value: unknown): BridgeConfig {
  const parsed = configSchema.parse(value);
  return parsed as BridgeConfig;
}

function redactEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  return Object.fromEntries(Object.keys(env).map((key) => [key, REDACTED_VALUE]));
}

function redactEnvRecord<T extends { env?: Record<string, string> }>(items: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(items).map(([id, item]) => {
    const clone = { ...item };
    if (item.env) clone.env = redactEnv(item.env);
    return [id, clone];
  }));
}

export function redactConfig(config: BridgeConfig): BridgeConfig {
  return {
    ...config,
    channels: Object.fromEntries(Object.entries(config.channels).map(([id, channel]) => [id, { ...channel }])),
    profiles: redactEnvRecord(config.profiles),
    agents: redactEnvRecord(config.agents),
    routes: config.routes.map((route) => ({
      ...route,
      match: route.match ? { ...route.match, chatIds: route.match.chatIds ? [...route.match.chatIds] : undefined } : undefined,
    })),
  };
}

export async function loadConfig(configPath = defaultConfigPath()): Promise<BridgeConfig> {
  try {
    const raw = await readFile(configPath, "utf-8");
    return parseConfig(JSON.parse(raw));
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return emptyConfig();
    }
    throw err;
  }
}

export async function saveConfig(config: BridgeConfig, configPath = defaultConfigPath()): Promise<void> {
  parseConfig(config);
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  await chmod(configPath, 0o600);
}

export async function ensureConfig(configPath = defaultConfigPath()): Promise<BridgeConfig> {
  const config = await loadConfig(configPath);
  await saveConfig(config, configPath);
  return config;
}

export async function upsertChannel(channel: ChannelConfig, configPath = defaultConfigPath()): Promise<BridgeConfig> {
  const config = await loadConfig(configPath);
  config.channels[channel.id] = channel;
  await saveConfig(config, configPath);
  return config;
}

export async function upsertProfile(profile: ProfileConfig, configPath = defaultConfigPath()): Promise<BridgeConfig> {
  const config = await loadConfig(configPath);
  config.profiles[profile.id] = profile;
  await saveConfig(config, configPath);
  return config;
}

export async function upsertAgent(agent: AgentConfig, configPath = defaultConfigPath()): Promise<BridgeConfig> {
  const config = await loadConfig(configPath);
  config.agents[agent.id] = agent;
  await saveConfig(config, configPath);
  return config;
}

/**
 * Persists a lazily provisioned agent workspace (project id / folder / channel)
 * back into the config file, so later runs skip the provisioning CLI calls.
 */
export async function upsertAgentWorkspace(
  agentId: string,
  workspace: AgentWorkspaceConfig,
  configPath = defaultConfigPath(),
): Promise<BridgeConfig> {
  const config = await loadConfig(configPath);
  const agent = config.agents[agentId];
  if (!agent) throw new Error(`Agent not found: ${agentId}`);
  agent.workspace = { ...agent.workspace, ...workspace };
  await saveConfig(config, configPath);
  return config;
}

export async function upsertRoute(route: RouteConfig, configPath = defaultConfigPath()): Promise<BridgeConfig> {
  const config = await loadConfig(configPath);
  config.routes = [...config.routes.filter((existing) => existing.id !== route.id), route];
  await saveConfig(config, configPath);
  return config;
}
