import type { AgentConfig, AgentRunInput, AgentRunResult, AgentSessionRef, BridgeConfig, BridgeMessage, BridgeSession, ProfileConfig } from "../types.js";

export interface BuiltAgentCommand {
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface AgentSessionOperationResult {
  supported: boolean;
  detail: string;
  ref?: AgentSessionRef;
}

export interface AgentSessionSendOptions {
  run?: typeof runAgent;
}

function renderCustomArgs(args: string[] | undefined, prompt: string): string[] {
  if (!args?.length) return [];
  const rendered = args.map((arg) => arg.replaceAll("{prompt}", prompt));
  return args.some((arg) => arg.includes("{prompt}")) ? rendered : [...rendered, prompt];
}

function renderExtraArgs(args: string[] | undefined, prompt: string): string[] {
  if (!args?.length) return [];
  return args.map((arg) => arg.replaceAll("{prompt}", prompt));
}

function mergeEnv(profile?: ProfileConfig, agent?: AgentConfig): Record<string, string> | undefined {
  const env = { ...(profile?.env || {}), ...(agent?.env || {}) };
  if (profile?.home) env["HOME"] = profile.home;
  return Object.keys(env).length ? env : undefined;
}

function compatibilityDetail(kind: string): string {
  if (kind === "shell") return "shell command session; local bridge state is durable";
  return "compatibility mode: this adapter invokes the current CLI one message at a time until a stable create/send/resume API is wired";
}

export function resolveAgent(config: BridgeConfig, agentId: string): { agent: AgentConfig; profile?: ProfileConfig } {
  const agent = config.agents[agentId];
  if (!agent) throw new Error(`Agent not found: ${agentId}`);
  const profile = agent.profileId ? config.profiles[agent.profileId] : undefined;
  if (agent.profileId && !profile) throw new Error(`Profile not found for agent ${agentId}: ${agent.profileId}`);
  if (profile && profile.agentKind !== agent.kind) {
    throw new Error(`Profile ${profile.id} is for ${profile.agentKind}, not ${agent.kind}`);
  }
  return { agent, profile };
}

export function buildAgentCommand(config: BridgeConfig, agentId: string, input: AgentRunInput): BuiltAgentCommand {
  const { agent, profile } = resolveAgent(config, agentId);
  const prompt = input.message.text;
  const kind = agent.kind;
  const command = agent.command || profile?.command;
  const args = agent.args || profile?.args;
  const cwd = input.session?.cwd || agent.cwd || profile?.cwd;
  const env = mergeEnv(profile, agent);

  if (command) {
    return { command: [command, ...renderCustomArgs(args, prompt)], cwd, env };
  }

  if (kind === "codewith") {
    const base = ["codewith"];
    if (profile?.authProfile) base.push("--auth-profile", profile.authProfile);
    if (cwd) base.push("--cd", cwd);
    base.push("exec", prompt);
    return { command: base, cwd, env };
  }

  if (kind === "claude") {
    return { command: ["claude", "-p", prompt, ...renderExtraArgs(args, prompt)], cwd, env };
  }

  if (kind === "aicopilot") {
    return { command: ["aicopilot", "run", prompt, ...renderExtraArgs(args, prompt)], cwd, env };
  }

  return { command: ["sh", "-lc", prompt], cwd, env };
}

export function createAgentSessionRef(config: BridgeConfig, agentId: string): AgentSessionRef {
  const { agent } = resolveAgent(config, agentId);
  const timestamp = new Date().toISOString();
  return {
    kind: agent.kind,
    mode: "compatibility",
    createdAt: timestamp,
    updatedAt: timestamp,
    detail: compatibilityDetail(agent.kind),
  };
}

export function resumeAgentSessionRef(session: BridgeSession): AgentSessionOperationResult {
  return {
    supported: session.agentSession?.mode === "durable",
    ref: session.agentSession,
    detail: session.agentSession?.mode === "durable"
      ? "durable agent session ref is available"
      : "compatibility sessions do not expose agent-side resume; bridge binding state is still durable",
  };
}

export function cancelAgentSession(session: BridgeSession): AgentSessionOperationResult {
  return {
    supported: false,
    ref: session.agentSession,
    detail: `cancel is not implemented for ${session.agentSession?.kind || "unknown"} ${session.agentSession?.mode || "compatibility"} sessions`,
  };
}

export function closeAgentSession(session: BridgeSession): AgentSessionOperationResult {
  return {
    supported: session.agentSession?.mode === "durable",
    ref: session.agentSession,
    detail: session.agentSession?.mode === "durable"
      ? "durable close is adapter-owned"
      : "compatibility close only updates bridge session state",
  };
}

export async function sendAgentSessionMessage(
  config: BridgeConfig,
  session: BridgeSession,
  message: BridgeMessage,
  options: AgentSessionSendOptions = {},
): Promise<AgentRunResult> {
  const run = options.run || runAgent;
  return run(config, session.agentId, {
    message,
    route: { id: `session:${session.id}`, fromChannel: message.channelId, toAgent: session.agentId },
    session,
  });
}

export async function runAgent(config: BridgeConfig, agentId: string, input: AgentRunInput): Promise<AgentRunResult> {
  const { agent } = resolveAgent(config, agentId);
  const built = buildAgentCommand(config, agentId, input);
  const started = Bun.spawn(built.command, {
    cwd: built.cwd,
    env: { ...process.env, ...(built.env || {}) },
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  let timeout: Timer | undefined;
  const timeoutMs = agent.timeoutMs ?? 120_000;
  const exitPromise = started.exited;
  const result = await Promise.race([
    exitPromise,
    new Promise<number | null>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        started.kill();
        resolve(null);
      }, timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);

  const stdout = await new Response(started.stdout).text();
  const stderr = await new Response(started.stderr).text();
  return {
    agentId,
    command: built.command,
    cwd: built.cwd,
    exitCode: result,
    stdout,
    stderr,
    timedOut,
  };
}
