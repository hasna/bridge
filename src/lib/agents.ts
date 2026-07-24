import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** Raw subprocess result, before any codewith-specific reply/session extraction. */
export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type AgentSpawn = (
  command: string[],
  options: { cwd?: string; env?: Record<string, string>; timeoutMs: number },
) => Promise<SpawnResult>;

export interface RunAgentDeps {
  spawn?: AgentSpawn;
  /** Reads the codewith `--output-last-message` file; injectable for tests. */
  readOutput?: (path: string) => Promise<string | undefined>;
}

/**
 * Env keys that must never be inherited by a code-executing agent whose input is
 * attacker-influenced (inbound chat text). Matches obviously-credential-shaped
 * names; operators can re-add a specific key a tool genuinely needs via
 * profile.env / agent.env (explicit values always win).
 */
const SENSITIVE_ENV_PATTERN =
  /(^|_)(TOKEN|SECRET|SECRETS|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|API_?KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|SESSION_KEY|AUTH_TOKEN|BEARER)$/i;

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

/**
 * Collects the channel secret env var names the bridge itself reads (Telegram
 * bot tokens, webhook secrets). These are always stripped from agent env so a
 * code-executing agent driven by untrusted chat text cannot exfiltrate them.
 */
export function bridgeSecretEnvNames(config: BridgeConfig): Set<string> {
  const names = new Set<string>();
  for (const channel of Object.values(config.channels)) {
    if (channel.kind === "telegram") {
      names.add(channel.botTokenEnv || "TELEGRAM_BOT_TOKEN");
    }
    if (channel.kind === "webhook" && channel.secretEnv) {
      names.add(channel.secretEnv);
    }
  }
  return names;
}

/**
 * Builds the environment handed to a spawned agent. Starts from the process env
 * minus the bridge's own channel secrets and any credential-shaped keys, then
 * layers profile/agent env (which can intentionally re-introduce a specific key
 * a tool needs). `profile.home` maps to HOME.
 */
export function buildAgentEnv(
  config: BridgeConfig,
  profile: ProfileConfig | undefined,
  agent: AgentConfig | undefined,
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const overrides = mergeEnv(profile, agent) || {};
  const denied = bridgeSecretEnvNames(config);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (denied.has(key)) continue;
    if (SENSITIVE_ENV_PATTERN.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...overrides };
}

function compatibilityDetail(kind: string): string {
  if (kind === "shell") return "shell command session; local bridge state is durable";
  return "compatibility mode: this adapter invokes the current CLI one message at a time";
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

/**
 * Durable codewith runs are used when the agent is a codewith agent and no
 * custom command override short-circuits the adapter. Durable runs capture a
 * codewith session id and resume it across messages/restarts.
 */
export function isDurableCodewith(agent: AgentConfig, profile?: ProfileConfig): boolean {
  return agent.kind === "codewith" && !agent.command && !profile?.command;
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

// ─── codewith durable command construction ────────────────────────────────────

export interface CodewithArgsInput {
  prompt: string;
  outputFile: string;
  cwd?: string;
  /** Existing codewith session id to resume, if any. */
  sessionId?: string;
  extraArgs?: string[];
}

/** Builds the `codewith exec [...]` argv (without the accounts wrapper). */
export function buildCodewithExecArgs(input: CodewithArgsInput): string[] {
  const args = ["exec"];
  if (input.sessionId) args.push("resume", input.sessionId);
  args.push("--json", "--durable", "--skip-git-repo-check", "-o", input.outputFile);
  if (input.cwd) args.push("-C", input.cwd);
  if (input.extraArgs?.length) args.push(...input.extraArgs);
  args.push(input.prompt);
  return args;
}

/**
 * Wraps a codewith argv in `accounts run` so the bridge drives codewith under an
 * accounts-managed auth profile. Note: we always build an explicit
 * `codewith exec [resume <id>]` argv here — we never use `accounts run --resume`,
 * which maps to codewith's generic resume/--last (the most recent session for
 * the profile) and would cross-contaminate multiplexed conversations.
 */
export function buildAccountsCommand(authProfile: string | undefined, codewithArgs: string[]): string[] {
  const base = ["accounts", "run", "codewith"];
  if (authProfile) base.push("-p", authProfile);
  base.push("--", ...codewithArgs);
  return base;
}

const SESSION_ID_KEYS = new Set([
  "session_id", "sessionid", "conversation_id", "conversationid", "thread_id", "threadid",
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function searchSessionId(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || value === null || typeof value !== "object") return undefined;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const norm = key.toLowerCase().replaceAll("-", "_");
    if (SESSION_ID_KEYS.has(norm) && typeof raw === "string" && raw) return raw;
    if (norm === "id" && typeof raw === "string" && UUID_RE.test(raw)) return raw;
  }
  for (const raw of Object.values(value as Record<string, unknown>)) {
    const found = searchSessionId(raw, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** Extracts a codewith session id from `--json` JSONL event output. */
export function extractCodewithSessionId(jsonl: string): string | undefined {
  for (const line of jsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const found = searchSessionId(parsed);
    if (found) return found;
  }
  return undefined;
}

function coerceText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.map((item) => coerceText(item)).filter((v): v is string => Boolean(v));
    return parts.length ? parts.join("") : undefined;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return coerceText(obj["text"] ?? obj["content"] ?? obj["message"]);
  }
  return undefined;
}

/**
 * Extracts the final assistant/agent message text from `--json` JSONL output as
 * a fallback when the `--output-last-message` file is unavailable.
 */
export function extractCodewithLastMessage(jsonl: string): string | undefined {
  let last: string | undefined;
  for (const line of jsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = String(parsed["type"] || parsed["event"] || "").toLowerCase();
    if (type.includes("error")) continue;
    const role = String((parsed["role"] as string) || "").toLowerCase();
    const isAssistant = role === "assistant"
      || type.includes("assistant")
      || type.includes("agent_message")
      || type.includes("message");
    if (!isAssistant) continue;
    const text = coerceText(parsed["text"] ?? parsed["message"] ?? parsed["content"] ?? parsed["delta"]);
    if (text) last = text;
  }
  return last;
}

export function createAgentSessionRef(config: BridgeConfig, agentId: string): AgentSessionRef {
  const { agent, profile } = resolveAgent(config, agentId);
  const timestamp = new Date().toISOString();
  const durable = isDurableCodewith(agent, profile);
  return {
    kind: agent.kind,
    mode: durable ? "durable" : "compatibility",
    authProfile: durable ? profile?.authProfile : undefined,
    providerSessions: durable ? {} : undefined,
    createdAt: timestamp,
    updatedAt: timestamp,
    detail: durable
      ? "durable codewith session: resumes a per-profile codewith session id across messages and restarts"
      : compatibilityDetail(agent.kind),
  };
}

export function resumeAgentSessionRef(session: BridgeSession): AgentSessionOperationResult {
  const durable = session.agentSession?.mode === "durable";
  return {
    supported: durable,
    ref: session.agentSession,
    detail: durable
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

// ─── spawning ─────────────────────────────────────────────────────────────────

export const defaultAgentSpawn: AgentSpawn = async (command, options) => {
  const started = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  let timer: Timer | undefined;
  const result = await Promise.race([
    started.exited,
    new Promise<number | null>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        started.kill();
        resolve(null);
      }, options.timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);

  const stdout = await new Response(started.stdout).text();
  const stderr = await new Response(started.stderr).text();
  return { exitCode: result, stdout, stderr, timedOut };
};

async function defaultReadOutput(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
}

/** Resolves the active auth profile + resumable session id for a durable run. */
export function resolveDurableTarget(
  profile: ProfileConfig | undefined,
  session: BridgeSession | undefined,
): { authProfile?: string; sessionId?: string } {
  const ref = session?.agentSession;
  const authProfile = ref?.authProfile || profile?.authProfile;
  const sessionId = authProfile ? ref?.providerSessions?.[authProfile] : ref?.refId;
  return { authProfile, sessionId };
}

async function runCodewithDurable(
  config: BridgeConfig,
  agent: AgentConfig,
  profile: ProfileConfig | undefined,
  input: AgentRunInput,
  deps: RunAgentDeps,
): Promise<AgentRunResult> {
  const spawn = deps.spawn || defaultAgentSpawn;
  const readOutput = deps.readOutput || defaultReadOutput;
  const cwd = input.session?.cwd || agent.cwd || profile?.cwd;
  const env = buildAgentEnv(config, profile, agent);
  const { authProfile, sessionId } = resolveDurableTarget(profile, input.session);

  const dir = await mkdtemp(join(tmpdir(), "bridge-cw-"));
  const outputFile = join(dir, "last-message.txt");
  try {
    const codewithArgs = buildCodewithExecArgs({
      prompt: input.message.text,
      outputFile,
      cwd,
      sessionId,
      extraArgs: agent.args || profile?.args,
    });
    const command = buildAccountsCommand(authProfile, codewithArgs);
    const spawned = await spawn(command, { cwd, env, timeoutMs: agent.timeoutMs ?? 120_000 });

    const fileReply = (await readOutput(outputFile))?.trim();
    const replyText = fileReply || extractCodewithLastMessage(spawned.stdout);
    const capturedSessionId = extractCodewithSessionId(spawned.stdout) || sessionId;

    return {
      agentId: agent.id,
      command,
      cwd,
      exitCode: spawned.exitCode,
      stdout: spawned.stdout,
      stderr: spawned.stderr,
      timedOut: spawned.timedOut,
      replyText,
      stdoutStructured: true,
      providerSessionId: capturedSessionId,
      authProfile,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function runAgent(
  config: BridgeConfig,
  agentId: string,
  input: AgentRunInput,
  deps: RunAgentDeps = {},
): Promise<AgentRunResult> {
  const { agent, profile } = resolveAgent(config, agentId);

  if (isDurableCodewith(agent, profile)) {
    return runCodewithDurable(config, agent, profile, input, deps);
  }

  const built = buildAgentCommand(config, agentId, input);
  const spawn = deps.spawn || defaultAgentSpawn;
  const spawned = await spawn(built.command, {
    cwd: built.cwd,
    env: buildAgentEnv(config, profile, agent),
    timeoutMs: agent.timeoutMs ?? 120_000,
  });
  return {
    agentId,
    command: built.command,
    cwd: built.cwd,
    exitCode: spawned.exitCode,
    stdout: spawned.stdout,
    stderr: spawned.stderr,
    timedOut: spawned.timedOut,
  };
}

/**
 * Persists the durable provider session id (and active auth profile) captured by
 * a run back onto the bridge session, so the next message resumes it. Returns
 * true when the session ref changed.
 */
export function recordDurableSession(session: BridgeSession, agent: AgentRunResult): boolean {
  if (!agent.providerSessionId) return false;
  const ref = session.agentSession;
  if (!ref || ref.mode !== "durable") return false;
  const profileKey = agent.authProfile || ref.authProfile || "default";
  ref.providerSessions = ref.providerSessions || {};
  const changed = ref.providerSessions[profileKey] !== agent.providerSessionId
    || ref.refId !== agent.providerSessionId
    || ref.authProfile !== agent.authProfile;
  ref.providerSessions[profileKey] = agent.providerSessionId;
  ref.refId = agent.providerSessionId;
  if (agent.authProfile) ref.authProfile = agent.authProfile;
  ref.updatedAt = new Date().toISOString();
  return changed;
}
