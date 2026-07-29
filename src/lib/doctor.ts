import { stat } from "node:fs/promises";
import { defaultConfigPath } from "./paths.js";
import { loadConfig } from "./config.js";
import { defaultStatePath } from "./state.js";
import { daemonPaths, daemonStatus } from "./daemon.js";
import { diagnoseIMessage } from "./imessage.js";
import { telegramApiBaseInfo } from "./telegram.js";
import type { DoctorCheck, DoctorReport } from "../types.js";

function isNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}

async function privateFileCheck(name: string, path: string): Promise<DoctorCheck> {
  try {
    const info = await stat(path);
    const mode = info.mode & 0o777;
    const ok = (mode & 0o077) === 0;
    return { name, ok, detail: `${path} mode=${mode.toString(8)}` };
  } catch (err) {
    if (isNotFound(err)) return { name, ok: true, detail: `not created yet: ${path}` };
    return { name, ok: false, detail: `${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function privateDirCheck(name: string, path: string): Promise<DoctorCheck> {
  try {
    const info = await stat(path);
    const mode = info.mode & 0o777;
    const ok = (mode & 0o077) === 0;
    return { name, ok, detail: `${path} mode=${mode.toString(8)}` };
  } catch (err) {
    if (isNotFound(err)) return { name, ok: true, detail: `not created yet: ${path}` };
    return { name, ok: false, detail: `${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Resolve against this process's PATH, the same way the agent runner spawns
 * commands. The previous implementation used a *login* shell (`sh -lc`), which
 * re-sources the user's profile and therefore answered for a PATH the bridge
 * process does not have — reporting `ok` for a runtime that a launchd/systemd
 * managed daemon, with its minimal environment, cannot actually execute.
 */
function commandExists(command: string): boolean {
  // PATH is passed explicitly: Bun.which() otherwise resolves against the PATH
  // captured at process start, not the one the agent runner will spawn with.
  return Bun.which(command, { PATH: process.env["PATH"] ?? "" }) !== null;
}

export interface DoctorOptions {
  /** Daemon metadata/log directory to inspect. Defaults to the standard one. */
  daemonDir?: string;
}

/**
 * Agent runtimes bridge shells out to. A missing binary only breaks this
 * installation when an agent is actually configured to use that runtime and has
 * no explicit command of its own, so the check is a warning otherwise.
 */
const OPTIONAL_AGENT_RUNTIMES = ["codewith", "claude", "aicopilot"] as const;

export async function doctor(
  configPath = defaultConfigPath(),
  statePath = defaultStatePath(),
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const config = await loadConfig(configPath);
  const paths = daemonPaths(options.daemonDir);
  const daemon = await daemonStatus({ daemonDir: paths.dir });

  checks.push(await privateFileCheck("config", configPath));
  checks.push(await privateFileCheck("state", statePath));
  checks.push(await privateDirCheck("daemon-dir", paths.dir));
  checks.push(await privateFileCheck("daemon-metadata", paths.metadataFile));
  checks.push({
    name: "daemon-status",
    // Stale metadata is reaped by `daemonStatus`, so it is only still reported
    // when reaping was blocked by a concurrent daemon operation — transient, and
    // not a reason to fail a health gate.
    ok: !daemon.stale,
    severity: "warn",
    detail: daemon.running
      ? `running pid=${daemon.pid}`
      : daemon.stale
        ? `stale pid=${daemon.pid}: ${daemon.detail}`
        : daemon.reaped
          ? `not running; ${daemon.detail}`
          : "not running",
  });

  try {
    const apiBase = telegramApiBaseInfo();
    checks.push({
      name: "telegram-api-base",
      ok: true,
      detail: apiBase.overridden ? `overridden: ${apiBase.origin}${apiBase.pathname}` : apiBase.origin,
    });
  } catch (err) {
    checks.push({
      name: "telegram-api-base",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  checks.push({ name: "command:bridge", ok: true, detail: "current package" });
  for (const runtime of OPTIONAL_AGENT_RUNTIMES) {
    const dependants = Object.values(config.agents).filter((agent) => {
      if (agent.kind !== runtime) return false;
      // An agent with an explicit command never invokes the runtime binary.
      return !(agent.command || (agent.profileId && config.profiles[agent.profileId]?.command));
    });
    const required = dependants.length > 0;
    checks.push({
      name: `command:${runtime}`,
      ok: commandExists(runtime),
      severity: required ? "error" : "warn",
      detail: required
        ? `required by agent(s): ${dependants.map((agent) => agent.id).join(", ")}`
        : "optional; no configured agent uses this runtime",
    });
  }

  const telegramChannels = Object.values(config.channels).filter((channel) => channel.kind === "telegram");
  for (const channel of telegramChannels) {
    const envName = channel.botTokenEnv || "TELEGRAM_BOT_TOKEN";
    // No token means this channel cannot receive or send at all: a hard failure,
    // even though the process may still be "running".
    checks.push({
      name: `telegram-token:${channel.id}`,
      ok: Boolean(process.env[envName]),
      severity: "error",
      detail: envName,
    });
    checks.push({
      name: `telegram-allowlist:${channel.id}`,
      ok: Boolean(channel.allowAllChats || channel.allowedChatIds?.length),
      detail: channel.allowAllChats ? "allowAllChats=true" : `${channel.allowedChatIds?.length || 0} chat id(s)`,
    });
  }

  for (const channel of Object.values(config.channels)) {
    if (!channel.defaultAgentId) continue;
    checks.push({
      name: `default-agent:${channel.id}`,
      ok: Boolean(config.agents[channel.defaultAgentId]),
      detail: `${channel.id} -> ${channel.defaultAgentId}`,
    });
  }

  for (const agent of Object.values(config.agents)) {
    if (!agent.fallbackProfileIds?.length) continue;
    const problems = agent.fallbackProfileIds.filter((id) => {
      const profile = config.profiles[id];
      return !profile || profile.agentKind !== agent.kind;
    });
    checks.push({
      name: `auth-rotation:${agent.id}`,
      ok: problems.length === 0,
      detail: problems.length === 0
        ? `${1 + agent.fallbackProfileIds.length} profile(s) in rotation pool`
        : `invalid fallback profile(s): ${problems.join(", ")}`,
    });
  }

  for (const route of config.routes) {
    checks.push({
      name: `route:${route.id}`,
      ok: Boolean(config.channels[route.fromChannel] && config.agents[route.toAgent]),
      detail: `${route.fromChannel} -> ${route.toAgent}`,
    });
  }

  const imessageChannels = Object.values(config.channels).filter((channel) => channel.kind === "imessage");
  for (const channel of imessageChannels) {
    checks.push(...await diagnoseIMessage(channel));
  }

  // `ok` gates CI and scripts: only error-severity failures make the bridge
  // unhealthy. Warnings are still reported with `ok: false` on the check itself.
  return { ok: checks.every((check) => check.ok || check.severity === "warn"), configPath, checks };
}
