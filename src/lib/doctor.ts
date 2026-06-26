import { access } from "node:fs/promises";
import { defaultConfigPath } from "./paths.js";
import { loadConfig } from "./config.js";
import type { DoctorCheck, DoctorReport } from "../types.js";

async function commandExists(command: string): Promise<boolean> {
  const proc = Bun.spawn(["sh", "-lc", `command -v ${command} >/dev/null 2>&1`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}

export async function doctor(configPath = defaultConfigPath()): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let config = await loadConfig(configPath);

  try {
    await access(configPath);
    checks.push({ name: "config", ok: true, detail: configPath });
  } catch {
    checks.push({ name: "config", ok: true, detail: `not created yet: ${configPath}` });
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

  return { ok: checks.every((check) => check.ok), configPath, checks };
}
