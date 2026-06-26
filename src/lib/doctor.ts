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

async function commandExists(command: string): Promise<boolean> {
  const proc = Bun.spawn(["sh", "-lc", `command -v ${command} >/dev/null 2>&1`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}

export async function doctor(configPath = defaultConfigPath(), statePath = defaultStatePath()): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const config = await loadConfig(configPath);
  const daemon = await daemonStatus();
  const paths = daemonPaths();

  checks.push(await privateFileCheck("config", configPath));
  checks.push(await privateFileCheck("state", statePath));
  checks.push(await privateDirCheck("daemon-dir", paths.dir));
  checks.push(await privateFileCheck("daemon-metadata", paths.metadataFile));
  checks.push({
    name: "daemon-status",
    ok: !daemon.stale,
    detail: daemon.running ? `running pid=${daemon.pid}` : daemon.stale ? `stale pid=${daemon.pid}` : "not running",
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

  for (const command of ["bridge", "codewith", "claude", "aicopilot"]) {
    checks.push({
      name: `command:${command}`,
      ok: command === "bridge" ? true : await commandExists(command),
      detail: command === "bridge" ? "current package" : undefined,
    });
  }

  const telegramChannels = Object.values(config.channels).filter((channel) => channel.kind === "telegram");
  for (const channel of telegramChannels) {
    const envName = channel.botTokenEnv || "TELEGRAM_BOT_TOKEN";
    checks.push({
      name: `telegram-token:${channel.id}`,
      ok: Boolean(process.env[envName]),
      detail: envName,
    });
    checks.push({
      name: `telegram-allowlist:${channel.id}`,
      ok: Boolean(channel.allowAllChats || channel.allowedChatIds?.length),
      detail: channel.allowAllChats ? "allowAllChats=true" : `${channel.allowedChatIds?.length || 0} chat id(s)`,
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

  return { ok: checks.every((check) => check.ok), configPath, checks };
}
