import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig, AgentRunInput, AgentRunResult, AgentSessionRef, BridgeConfig, BridgeMessage, BridgeSession, ProfileConfig } from "../types.js";
import { ensureAgentWorkspace, type ProvisionDeps } from "./provision.js";

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
  /**
   * Optional proactive usage probe (e.g. backed by `codewith usage`). When it
   * resolves true for an auth profile, that profile is treated as exhausted and
   * skipped before spawning, so rotation prefers a profile with remaining usage
   * instead of burning a doomed request first. Injectable for tests.
   */
  checkUsageExhausted?: (authProfile: string | undefined) => Promise<boolean> | boolean;
  /**
   * Per-agent workspace provisioning hooks (projects/conversations exec,
   * config persistence, workspace root). Provisioning only happens when this
   * is provided — the CLI serve/ask entry points wire it (with `persist` so a
   * lazily provisioned workspace lands in the config file); bare library calls
   * and tests without it never touch provisioning CLIs or the filesystem.
   */
  provision?: ProvisionDeps;
}

/**
 * Explicit allow-list of the environment a code-executing agent (whose input is
 * attacker-influenced inbound chat text) may inherit from the station process.
 * Everything not on this list — or a configured passthrough — is dropped, so
 * station secrets that do NOT happen to match a credential-shaped name pattern
 * (e.g. `DATABASE_URL`, `AWS_ACCESS_KEY_ID`, `TELEGRAM_SESSION`) never leak. A
 * tool that genuinely needs another var gets it via profile/agent `env` (explicit
 * values) or `envPassthrough` (names / `PREFIX*` globs), never by default.
 */
const DEFAULT_ENV_ALLOWLIST = new Set<string>([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "OLDPWD",
  "TERM", "COLORTERM", "LANG", "LANGUAGE", "TZ", "HOSTNAME",
  "TMPDIR", "TMP", "TEMP",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "CURL_CA_BUNDLE",
]);

/** Allow-listed prefixes: locale, XDG base dirs, and the toolchains that resolve
 * the `accounts` / `codewith` / `bun` binaries and their per-profile homes. */
const DEFAULT_ENV_ALLOW_PREFIXES = [
  "LC_", "XDG_", "CODEWITH_", "ACCOUNTS_", "BUN_",
  "NVM_", "FNM_", "VOLTA_", "ASDF_", "MISE_",
];

/**
 * Secondary guard applied to allow-listed / passed-through keys only, so an overly
 * broad passthrough glob (e.g. `AWS_*`) still cannot smuggle a credential-shaped
 * var through. Explicit profile/agent `env` values are exempt (operator intent).
 */
const SENSITIVE_ENV_PATTERN =
  /(^|_)(TOKEN|SECRET|SECRETS|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|API_?KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|SESSION_KEY|AUTH_TOKEN|BEARER)$/i;

interface EnvPassthroughSpec {
  exact: Set<string>;
  prefixes: string[];
}

/** Parses profile/agent `envPassthrough` entries into exact names and `PREFIX*` globs. */
export function envPassthroughSpec(profile?: ProfileConfig, agent?: AgentConfig): EnvPassthroughSpec {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const raw of [...(profile?.envPassthrough || []), ...(agent?.envPassthrough || [])]) {
    if (raw.endsWith("*")) prefixes.push(raw.slice(0, -1));
    else exact.add(raw);
  }
  return { exact, prefixes };
}

function envKeyAllowed(key: string, spec: EnvPassthroughSpec): boolean {
  if (DEFAULT_ENV_ALLOWLIST.has(key) || spec.exact.has(key)) return true;
  return DEFAULT_ENV_ALLOW_PREFIXES.some((p) => key.startsWith(p))
    || spec.prefixes.some((p) => key.startsWith(p));
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
 * Builds the environment handed to a spawned agent using an explicit allow-list:
 * only {@link DEFAULT_ENV_ALLOWLIST} / {@link DEFAULT_ENV_ALLOW_PREFIXES} vars and
 * configured `envPassthrough` names survive from the station process. The bridge's
 * own channel secrets and any credential-shaped key are additionally stripped even
 * if allow-listed. Profile/agent `env` is then layered on top and always wins
 * (this is how a tool re-introduces a specific key it needs). `profile.home` maps
 * to HOME. The full station environment is never inherited.
 */
export function buildAgentEnv(
  config: BridgeConfig,
  profile: ProfileConfig | undefined,
  agent: AgentConfig | undefined,
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const overrides = mergeEnv(profile, agent) || {};
  const denied = bridgeSecretEnvNames(config);
  const spec = envPassthroughSpec(profile, agent);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (!envKeyAllowed(key, spec)) continue;      // allow-list: drop everything else
    if (denied.has(key)) continue;                // never inherit the bridge's own secrets
    if (SENSITIVE_ENV_PATTERN.test(key)) continue; // secondary guard on allow-listed keys
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
    base.push("exec", ...CODEWITH_YOLO_ARGS, prompt);
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
  /** Existing codewith thread id to resume, if any. */
  sessionId?: string;
  /**
   * codewith auth profile (billing account) to run this turn under. Emitted as
   * codewith's native `--auth-profile <name>` global flag, which selects the
   * paying account WITHOUT changing the active profile — and, crucially, without
   * changing the CODEWITH_HOME, so the resumed thread (see {@link sessionId}) is
   * read from the SAME shared `sessions/` store. This is how a rotation switches
   * only the billing account while keeping the conversation thread.
   */
  authProfile?: string;
  extraArgs?: string[];
}

/**
 * Flags that make a bridge codewith run able to ACT (full YOLO mode):
 * - `--skip-git-repo-check`: the agent cwd is its own project folder, not a
 *   trusted git checkout, so codewith must not fail closed with
 *   "Not inside a trusted directory".
 * - `--dangerously-bypass-approvals-and-sandbox`: full bypass of approvals AND
 *   the sandbox. Without it a non-interactive exec runs `sandbox: read-only,
 *   approval: never` — view-only, unable to write/exec or leave its folder.
 *   Bridge agents are intentionally full-yolo: they act anywhere on the station.
 */
export const CODEWITH_YOLO_ARGS = [
  "--skip-git-repo-check",
  "--dangerously-bypass-approvals-and-sandbox",
] as const;

/**
 * Builds the `codewith exec [...]` argv (invoked directly, NOT wrapped in
 * `accounts run codewith -p`). The accounts wrapper points CODEWITH_HOME at a
 * per-account directory, which forks the thread store per billing account; here
 * we keep one shared home and select the account with codewith's own
 * `--auth-profile`, so a thread created under account A is resumable under B.
 * The run is full-YOLO ({@link CODEWITH_YOLO_ARGS}): trusted-directory check
 * bypassed and approvals/sandbox fully bypassed so the agent can act.
 */
export function buildCodewithExecArgs(input: CodewithArgsInput): string[] {
  const args = ["exec"];
  if (input.sessionId) args.push("resume", input.sessionId);
  if (input.authProfile) args.push("--auth-profile", input.authProfile);
  args.push("--json", "--durable", ...CODEWITH_YOLO_ARGS, "-o", input.outputFile);
  if (input.cwd) args.push("-C", input.cwd);
  if (input.extraArgs?.length) args.push(...input.extraArgs);
  args.push(input.prompt);
  return args;
}

/**
 * Resolves the shared, stable codewith home for durable runs. codewith stores
 * threads/rollouts under `CODEWITH_HOME/sessions` and billing accounts under
 * `CODEWITH_HOME/auth_profiles`, so pinning ONE home — independent of any
 * per-profile HOME — is what lets every billing account see and resume the same
 * conversation thread. Resolves `$CODEWITH_HOME`, else `~/.codewith` (codewith's
 * own default via find_codex_home()).
 */
export function resolveCodewithHome(baseEnv: Record<string, string | undefined> = process.env): string {
  return baseEnv["CODEWITH_HOME"] || join(baseEnv["HOME"] || homedir(), ".codewith");
}

/**
 * Builds the codewith command invoked directly — NOT wrapped in
 * `accounts run codewith -p <profile>`. The accounts wrapper points
 * CODEWITH_HOME at a per-account directory, forking the thread store per billing
 * account (so a thread created under account A is invisible under account B).
 * Instead we run one shared home and select the paying account with codewith's
 * own `--auth-profile` flag (emitted by {@link buildCodewithExecArgs}). We always
 * pass an explicit `codewith exec [resume <id>]` argv — never a generic
 * resume/--last, which would cross-contaminate multiplexed conversations.
 * Full-YOLO ({@link CODEWITH_YOLO_ARGS}) is carried by the exec argv, so the
 * direct invocation still bypasses approvals/sandbox and can act.
 */
export function buildCodewithCommand(codewithArgs: string[]): string[] {
  return ["codewith", ...codewithArgs];
}

const SESSION_ID_KEYS = new Set([
  "session_id", "sessionid", "conversation_id", "conversationid", "thread_id", "threadid",
]);
// Nested containers whose `id` is a session id, e.g. {"session":{"id":"..."}}.
const SESSION_CONTAINER_KEYS = new Set(["session", "thread", "conversation"]);

function searchSessionId(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || value === null || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  for (const [key, raw] of Object.entries(obj)) {
    const norm = key.toLowerCase().replaceAll("-", "_");
    // Explicit session-id keys are the strongest, least ambiguous signal.
    if (SESSION_ID_KEYS.has(norm) && typeof raw === "string" && raw) return raw;
    // A session/thread/conversation container object carrying an id/session_id.
    if (SESSION_CONTAINER_KEYS.has(norm) && raw && typeof raw === "object") {
      const nested = raw as Record<string, unknown>;
      const id = nested["id"] ?? nested["session_id"] ?? nested["sessionId"];
      if (typeof id === "string" && id) return id;
    }
  }
  for (const raw of Object.values(obj)) {
    const found = searchSessionId(raw, depth + 1);
    if (found) return found;
  }
  return undefined;
}

// The canonical codewith --json session-start events. `thread.started` carries
// `thread_id`; older/aliased shapes carry `session_id` (or a nested container).
const SESSION_START_EVENT_TYPES = new Set([
  "thread.started", "thread_started", "session.created", "session_created",
  "session.started", "session_started", "session_configured",
]);

/**
 * Extracts a codewith session id from `--json` JSONL event output. Prefers the
 * canonical session-start event (`{"type":"thread.started","thread_id":"<uuid>"}`
 * and its aliases) so we bind to the real session id rather than any later event
 * that merely echoes an id; falls back to a generic scan for older shapes.
 */
export function extractCodewithSessionId(jsonl: string): string | undefined {
  const events: Record<string, unknown>[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;
    try {
      events.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      continue;
    }
  }
  // First pass: the explicit session-start event is the authoritative source.
  for (const ev of events) {
    const type = String(ev["type"] ?? ev["event"] ?? "").toLowerCase().replaceAll("-", "_");
    if (!SESSION_START_EVENT_TYPES.has(type)) continue;
    const found = searchSessionId(ev);
    if (found) return found;
  }
  // Fallback: generic search across all events for older/unknown shapes.
  for (const ev of events) {
    const found = searchSessionId(ev);
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

/**
 * Non-fatal tool diagnostics interleaved in codewith stderr, e.g.
 * `2026-07-24T14:24:27Z ERROR codex_core::shell_snapshot: Shell snapshot
 * validation failed: ...`. These are warnings about auxiliary features — they
 * must never fail a run nor be surfaced to the user as the failure reason.
 *
 * Deliberately narrow so GENUINE fatal stderr (e.g. `ERROR: invalid API key`)
 * survives into user-facing failure text. Only three shapes are noise:
 * 1. TRACE/DEBUG lines (timestamped or not) — never user-relevant;
 * 2. timestamped tracing-crate log lines with a `module::path:` target
 *    (the shell_snapshot warning shape), regardless of level;
 * 3. codewith's `Reading additional input from stdin...` prompt echo.
 */
const AGENT_LOG_NOISE_PATTERN = new RegExp(
  [
    String.raw`^\s*(?:\d{4}-\d{2}-\d{2}[T ][0-9:.]+Z?\s+)?(?:TRACE|DEBUG)\b.*$`,
    String.raw`^\s*\d{4}-\d{2}-\d{2}[T ][0-9:.]+Z?\s+(?:INFO|WARN|WARNING|ERROR)\s+[\w.\[\]-]+(?:::[\w.\[\]-]+)+:.*$`,
    String.raw`^\s*Reading additional input from stdin\.{3}\s*$`,
  ].join("|"),
);

/** Strips non-fatal tool log lines (shell_snapshot warnings etc.) from output,
 * while KEEPING genuine fatal stderr such as `ERROR: invalid API key`. */
export function filterAgentLogNoise(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !AGENT_LOG_NOISE_PATTERN.test(line))
    .join("\n")
    .trim();
}

function coerceErrorDetail(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim();
  // codewith error events often carry a JSON-encoded provider error as the
  // message; unwrap it (recursively) so the user sees the actual reason.
  if (trimmed.startsWith("{")) {
    try {
      const nested = JSON.parse(trimmed) as Record<string, unknown>;
      const inner = nested["error"];
      const innerMessage = inner && typeof inner === "object"
        ? (inner as Record<string, unknown>)["message"]
        : nested["message"];
      const unwrapped = coerceErrorDetail(typeof innerMessage === "string" ? innerMessage : undefined);
      if (unwrapped) return unwrapped;
    } catch {
      // not JSON after all — use as-is
    }
  }
  return trimmed;
}

/**
 * Extracts a human-readable error message from codewith `--json` JSONL output
 * (`{"type":"error",...}` / `{"type":"turn.failed","error":{...}}` events),
 * unwrapping nested JSON-encoded provider errors. Used to surface a CLEAR error
 * reply instead of raw JSONL or stderr noise.
 */
export function extractCodewithErrorMessage(jsonl: string): string | undefined {
  let last: string | undefined;
  for (const ev of jsonlEvents(jsonl)) {
    const type = String(ev["type"] ?? ev["event"] ?? "").toLowerCase();
    if (!type.includes("error") && !type.includes("fail")) continue;
    const err = ev["error"];
    const candidate = err && typeof err === "object"
      ? (err as Record<string, unknown>)["message"]
      : ev["message"] ?? err;
    const detail = coerceErrorDetail(typeof candidate === "string" ? candidate : undefined);
    if (detail) last = detail;
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
    createdAt: timestamp,
    updatedAt: timestamp,
    detail: durable
      ? "durable codewith session: resumes one shared codewith thread across messages, restarts, and billing-account rotation"
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

/**
 * Resolves the cwd a codewith run executes in. An explicit cwd (session, agent,
 * profile) always wins; otherwise the agent's OWN provisioned project folder is
 * used (lazily provisioning it — plus the agent's `agent-<name>` conversations
 * channel — on first use). YOLO mode means the agent can still act anywhere on
 * the station; the project folder is its home base, not a boundary.
 *
 * Provisioning is strictly opt-in via `deps.provision` (wired by the CLI
 * serve/ask entry points): a bare library `runAgent` call must never spawn
 * provisioning CLIs or touch the filesystem as a side effect. Provisioning
 * problems never fail the run: worst case the run keeps the station default
 * cwd, exactly as before.
 */
export async function resolveAgentCwd(
  config: BridgeConfig,
  agent: AgentConfig,
  profile: ProfileConfig | undefined,
  session: BridgeSession | undefined,
  deps: RunAgentDeps = {},
): Promise<string | undefined> {
  const explicit = session?.cwd || agent.cwd || profile?.cwd;
  if (explicit) return explicit;
  if (!deps.provision) return undefined;
  try {
    const workspace = await ensureAgentWorkspace(config, agent.id, deps.provision);
    return workspace.path;
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
  // The thread id is the single shared refId, resumable under ANY billing
  // account (not keyed by auth profile).
  const sessionId = ref?.refId;
  return { authProfile, sessionId };
}

// ─── structured codewith --json error-event classification ────────────────────

export interface SpawnLike {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Parses each JSONL line of the given texts, skipping non-JSON noise. */
function* jsonlEvents(...texts: string[]): Generator<Record<string, unknown>> {
  for (const text of texts) {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== "{") continue;
      try {
        yield JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // skip malformed line
      }
    }
  }
}

/**
 * If `ev` is a codewith `--json` *error* event, collapses its diagnostic fields
 * (type/code/status/message and any nested `error` object) into one lowercased
 * string for classification. Returns undefined for non-error events, so we
 * classify structured events rather than raw-string matching the whole output.
 */
function errorEventText(ev: Record<string, unknown>): string | undefined {
  const type = String(ev["type"] ?? ev["event"] ?? "").toLowerCase();
  const err = ev["error"];
  const isError = type.includes("error") || type.includes("fail")
    || err !== undefined || ev["error_code"] !== undefined;
  if (!isError) return undefined;
  const parts: unknown[] = [type, ev["message"], ev["code"], ev["status"], ev["error_code"], ev["reason"]];
  if (err && typeof err === "object") {
    const eo = err as Record<string, unknown>;
    parts.push(eo["type"], eo["code"], eo["message"], eo["status"], eo["reason"]);
  } else {
    parts.push(err);
  }
  return parts
    .filter((p) => typeof p === "string" || typeof p === "number")
    .map((p) => String(p))
    .join(" ")
    .toLowerCase();
}

const EXHAUSTION_PATTERN =
  /(rate[ _-]?limit|ratelimited|too many requests|\b429\b|quota|usage[ _-]?(?:limit|cap)|insufficient[ _-]?quota|out of credit|no credit|credit balance|auth(?:entication)?[ _-]?(?:expired|failed|error|required|invalid)|unauthorized|token expired|\b401\b|\b403\b|exhausted|overloaded)/i;

// ─── profile auth rotation on exhaustion ──────────────────────────────────────

/**
 * Whether a (failed) run hit a usage/quota/auth exhaustion signal. Detection is
 * structured: only non-zero, non-timeout runs qualify, and the classification
 * reads codewith `--json` *error events* (their type/code/message fields), not a
 * brittle raw-string match over the whole stdout/stderr blob.
 */
export function isExhaustionSignal(result: SpawnLike): boolean {
  if (result.timedOut) return false;
  if (result.exitCode === 0) return false;
  for (const ev of jsonlEvents(result.stdout, result.stderr)) {
    const text = errorEventText(ev);
    if (text && EXHAUSTION_PATTERN.test(text)) return true;
  }
  return false;
}

/**
 * Whether a (failed) run indicates the resumed codewith session id no longer
 * exists (rollout deleted / session expired / unknown thread), so the turn should
 * be retried on a fresh session rather than failing forever. Reads structured
 * `--json` error events, matching an error that names a session/thread/rollout
 * subject together with a not-found/expired/invalid qualifier.
 */
export function isStaleSessionSignal(result: SpawnLike): boolean {
  if (result.timedOut) return false;
  if (result.exitCode === 0) return false;
  for (const ev of jsonlEvents(result.stdout, result.stderr)) {
    const text = errorEventText(ev);
    if (!text) continue;
    const hasSubject = /(session|thread|conversation|rollout)/.test(text);
    const hasMissing = /(not[ _-]?found|no such|does ?n['o]?t exist|doesn't exist|unknown|no longer|missing|invalid|expired|gone|cannot be found|could not be found)/.test(text);
    if (hasSubject && hasMissing) return true;
  }
  return false;
}

/**
 * Ordered auth-rotation pool for an agent: [profileId, ...fallbackProfileIds],
 * de-duplicated, validated to exist and match the agent kind. Throws on
 * misconfiguration so it surfaces loudly rather than silently skipping.
 */
export function rotationProfiles(config: BridgeConfig, agent: AgentConfig): ProfileConfig[] {
  const ids = [agent.profileId, ...(agent.fallbackProfileIds || [])].filter((id): id is string => Boolean(id));
  const seen = new Set<string>();
  const out: ProfileConfig[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const profile = config.profiles[id];
    if (!profile) throw new Error(`Agent ${agent.id} references unknown profile: ${id}`);
    if (profile.agentKind !== agent.kind) {
      throw new Error(`Profile ${profile.id} is for ${profile.agentKind}, not ${agent.kind}`);
    }
    out.push(profile);
  }
  return out;
}

/** The profile a session is currently pinned to (by active auth profile), or the pool head. */
export function activeRotationProfile(config: BridgeConfig, agent: AgentConfig, session: BridgeSession | undefined): ProfileConfig | undefined {
  const pool = rotationProfiles(config, agent);
  const active = session?.agentSession?.authProfile;
  if (active) {
    const found = pool.find((profile) => profile.authProfile === active);
    if (found) return found;
  }
  return pool[0];
}

/** The next profile after the one bound to `currentAuthProfile`, or undefined if there is no other. */
export function nextRotationProfile(config: BridgeConfig, agent: AgentConfig, currentAuthProfile: string | undefined): ProfileConfig | undefined {
  const pool = rotationProfiles(config, agent);
  if (pool.length <= 1) return undefined;
  const idx = pool.findIndex((profile) => profile.authProfile === currentAuthProfile);
  if (idx === -1) return pool[0];
  const next = pool[idx + 1];
  return next && next.authProfile !== currentAuthProfile ? next : undefined;
}

/** Builds the rotation try-order starting from the currently active profile. */
function rotationOrder(pool: ProfileConfig[], startAuthProfile: string | undefined): ProfileConfig[] {
  if (!pool.length) return [];
  let idx = startAuthProfile ? pool.findIndex((profile) => profile.authProfile === startAuthProfile) : 0;
  if (idx < 0) idx = 0;
  return pool.map((_, i) => pool[(idx + i) % pool.length]!);
}

async function runCodewithOnce(
  config: BridgeConfig,
  agent: AgentConfig,
  profile: ProfileConfig | undefined,
  input: AgentRunInput,
  deps: RunAgentDeps,
  options: { forceFresh?: boolean } = {},
): Promise<AgentRunResult> {
  const spawn = deps.spawn || defaultAgentSpawn;
  const readOutput = deps.readOutput || defaultReadOutput;
  const ref = input.session?.agentSession;
  const cwd = await resolveAgentCwd(config, agent, profile, input.session, deps);
  const env = buildAgentEnv(config, profile, agent);
  // Pin the shared codewith home so a per-profile HOME cannot fork the thread
  // store: every billing account resolves the SAME sessions/ store and can
  // therefore resume the same conversation thread. An explicit CODEWITH_HOME
  // (station/profile/agent env) is honoured; otherwise fall back to the shared
  // station default.
  env["CODEWITH_HOME"] = env["CODEWITH_HOME"] || resolveCodewithHome();
  const authProfile = profile?.authProfile;
  // The thread id is auth-independent: the same shared refId is resumed no matter
  // which billing account pays. forceFresh drops it so codewith starts a brand-new
  // thread (used by stale-session self-heal when the resume target has gone away).
  const sessionId = options.forceFresh ? undefined : ref?.refId;

  const dir = await mkdtemp(join(tmpdir(), "bridge-cw-"));
  const outputFile = join(dir, "last-message.txt");
  try {
    const codewithArgs = buildCodewithExecArgs({
      prompt: input.message.text,
      outputFile,
      cwd,
      sessionId,
      authProfile,
      extraArgs: agent.args || profile?.args,
    });
    const command = buildCodewithCommand(codewithArgs);
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
      exhausted: isExhaustionSignal(spawned),
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Runs one codewith turn on a single profile with stale-session self-heal: if the
 * run tried to resume a stored session id and codewith reports that session is
 * gone (rollout deleted / expired / unknown), it retries once with a fresh
 * session instead of failing the conversation forever.
 */
async function runCodewithProfileTurn(
  config: BridgeConfig,
  agent: AgentConfig,
  profile: ProfileConfig | undefined,
  input: AgentRunInput,
  deps: RunAgentDeps,
): Promise<AgentRunResult> {
  const first = await runCodewithOnce(config, agent, profile, input, deps);
  const ref = input.session?.agentSession;
  const attemptedResume = Boolean(ref?.refId);
  if (attemptedResume && isStaleSessionSignal(first)) {
    const fresh = await runCodewithOnce(config, agent, profile, input, deps, { forceFresh: true });
    fresh.staleSessionHealed = true;
    return fresh;
  }
  return first;
}

/**
 * Runs a durable codewith turn, rotating to the next auth profile when the
 * active one hits exhaustion (rate-limit / quota / auth-expired). Rotation
 * switches ONLY the billing account: the conversation's single codewith thread
 * lives in a shared, auth-independent store (see {@link resolveCodewithHome}), so
 * the next profile resumes the SAME thread id and conversation context carries
 * across the switch. The turn continues on the new profile in the same call, and
 * rotation is bounded to try each profile at most once.
 *
 * `contextReset` is therefore NOT set for a normal rotation — context is
 * preserved. It is set only when the thread is genuinely unrecoverable: a
 * stale-session self-heal that had to start a brand-new thread because the stored
 * one was gone/expired. That is the one case where callers must honestly tell the
 * user their prior context did not carry over.
 */
/**
 * Best-effort usage probe. It is an OPTIMISATION backed by an external CLI
 * (`codewith usage`), so a failure — CLI missing, network blip, timeout — must
 * mean "unknown" and let the profile run. Awaiting it unguarded let a probe
 * rejection propagate out of {@link runAgent} and fail the user's message even
 * though every billing account was healthy.
 */
async function probeUsageExhausted(deps: RunAgentDeps, authProfile: string): Promise<boolean> {
  if (!deps.checkUsageExhausted) return false;
  try {
    return Boolean(await deps.checkUsageExhausted(authProfile));
  } catch {
    return false;
  }
}

async function runCodewithDurable(
  config: BridgeConfig,
  agent: AgentConfig,
  primaryProfile: ProfileConfig | undefined,
  input: AgentRunInput,
  deps: RunAgentDeps,
): Promise<AgentRunResult> {
  const pool = rotationProfiles(config, agent);
  const start = activeRotationProfile(config, agent, input.session);
  const order = rotationOrder(pool, start?.authProfile);
  const candidates: (ProfileConfig | undefined)[] = order.length ? order : [primaryProfile];

  let last: AgentRunResult | undefined;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const authProfile = candidate?.authProfile;
    // Proactively skip a profile a usage probe already reports as exhausted, so
    // rotation prefers a profile with remaining usage rather than burning a
    // doomed request. Never skip the last remaining candidate.
    if (authProfile && i < candidates.length - 1) {
      if (await probeUsageExhausted(deps, authProfile)) continue;
    }
    const result = await runCodewithProfileTurn(config, agent, candidate, input, deps);
    result.rotated = i > 0;
    // Rotation resumes the SAME shared thread under the new billing account, so
    // context is preserved — no reset. Only a genuine stale-thread self-heal
    // (the stored thread was gone and a fresh one had to be started) drops it —
    // and only when that fresh thread actually WORKED. A heal whose retry also
    // failed produced no new thread and no reply, so reporting a context reset
    // there would misdescribe what happened to the conversation.
    if (result.staleSessionHealed && !result.timedOut && result.exitCode === 0) result.contextReset = true;
    last = result;
    if (!result.exhausted) break;
    // Exhausted: fall through to the next candidate profile (if any).
  }
  return last!;
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
  // Every compatibility agent (codewith, claude, aicopilot, shell, custom
  // command) executes from the agent's own provisioned project folder when no
  // explicit cwd is configured (durable runs resolve it inside runCodewithOnce).
  if (!built.cwd) {
    built.cwd = await resolveAgentCwd(config, agent, profile, input.session, deps);
  }
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
 * Persists the durable codewith thread id (and the active billing account)
 * captured by a run back onto the bridge session, so the next message resumes the
 * SAME thread. The thread id is stored once on `refId` — it is auth-independent
 * and shared across billing accounts, not keyed per profile. `authProfile` merely
 * records which account last paid, so the next turn starts on a profile that was
 * working. Returns true when the ref changed.
 *
 * A run that PROVED the stored thread is gone (stale-session self-heal) but
 * produced no replacement id also changes the ref: the dead pointer is dropped.
 * Keeping it pinned made every later message in the conversation pay a wasted
 * `codewith exec resume <dead-id>` spawn before the real one — forever — and
 * re-show the user the "I started a new session" note on every successful heal.
 */
export function recordDurableSession(session: BridgeSession, agent: AgentRunResult): boolean {
  const ref = session.agentSession;
  if (!ref || ref.mode !== "durable") return false;
  if (!agent.providerSessionId) {
    if (agent.staleSessionHealed && ref.refId !== undefined) {
      delete ref.refId;
      ref.updatedAt = new Date().toISOString();
      return true;
    }
    return false;
  }
  const changed = ref.refId !== agent.providerSessionId
    || (Boolean(agent.authProfile) && ref.authProfile !== agent.authProfile);
  ref.refId = agent.providerSessionId;
  if (agent.authProfile) ref.authProfile = agent.authProfile;
  ref.updatedAt = new Date().toISOString();
  return changed;
}
