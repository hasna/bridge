#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import {
  ensureConfig,
  loadConfig,
  saveConfig,
  upsertAgent,
  upsertChannel,
  upsertProfile,
  upsertRoute,
  daemonLogs,
  daemonPaths,
  daemonStatus,
  doctor,
  installDaemon,
  restartInstalledDaemon,
  restartProcessDaemon,
  routeMessage,
  runAgent,
  sendTelegramMessage,
  startInstalledDaemon,
  startProcessDaemon,
  stopInstalledDaemon,
  stopProcessDaemon,
  uninstallDaemon,
  getTelegramUpdates,
  telegramToken,
  telegramUpdateToMessage,
  defaultConfigPath,
  defaultStatePath,
  loadState,
  saveState,
  type AgentKind,
  type BridgeMessage,
  type TelegramChannelConfig,
} from "../index.js";

function version(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf-8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function asJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function parseEnv(values: string[] | undefined): Record<string, string> | undefined {
  if (!values?.length) return undefined;
  const env: Record<string, string> = {};
  for (const value of values) {
    const index = value.indexOf("=");
    if (index <= 0) throw new Error(`Invalid env assignment: ${value}`);
    env[value.slice(0, index)] = value.slice(index + 1);
  }
  return env;
}

function splitCsv(value: string | undefined): string[] | undefined {
  return value?.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseNonNegativeInt(value: string | undefined, name: string): number {
  const raw = value || "0";
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
  return Number.parseInt(raw, 10);
}

function printList(items: Record<string, unknown> | unknown[]): void {
  const rows = Array.isArray(items) ? items : Object.values(items);
  if (!rows.length) {
    console.log("No entries.");
    return;
  }
  for (const item of rows) console.log(JSON.stringify(item));
}

async function runServe(options: { once?: boolean; interval?: string; json?: boolean; state?: string; config?: string }): Promise<void> {
  const config = await loadConfig(options.config);
  const telegramChannels = Object.values(config.channels).filter(
    (channel): channel is TelegramChannelConfig => channel.kind === "telegram" && channel.enabled !== false,
  );
  const intervalMs = parseNonNegativeInt(options.interval || "1000", "--interval");
  if (!telegramChannels.length) throw new Error("No enabled Telegram channels configured");

  const statePath = options.state || defaultStatePath();
  const state = await loadState(statePath);
  const errorCounts = new Map<string, number>();
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  while (!stopping) {
    for (const channel of telegramChannels) {
      try {
        const updates = await getTelegramUpdates(telegramToken(channel), {
          offset: state.telegramOffsets[channel.id],
          timeoutSeconds: channel.pollTimeoutSeconds || 20,
        });
        errorCounts.delete(channel.id);
        for (const update of updates) {
          state.telegramOffsets[channel.id] = update.update_id + 1;
          await saveState(state, statePath);
          const message = telegramUpdateToMessage(channel.id, update);
          if (!message) continue;
          const results = await routeMessage(config, message, { writeConsole: options.json ? false : undefined });
          if (options.json) asJson({ message, results });
        }
      } catch (err) {
        if (options.once) throw err;
        const count = (errorCounts.get(channel.id) || 0) + 1;
        errorCounts.set(channel.id, count);
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[bridge] ${channel.id} poll failed (${count}): ${message}`);
        await Bun.sleep(Math.min(30_000, Math.max(1000, intervalMs * Math.min(count, 30))));
      }
    }
    if (options.once) break;
    await Bun.sleep(intervalMs);
  }
  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGINT", stop);
}

const program = new Command();
program
  .name("bridge")
  .description("Agent messaging bridge for Telegram and other channels")
  .version(version());

program
  .command("init")
  .description("Create an empty bridge config if missing")
  .option("-c, --config <path>", "config path", defaultConfigPath())
  .option("--json", "output JSON")
  .action(async (options) => {
    const config = await ensureConfig(options.config);
    const result = { path: options.config, config };
    if (options.json) asJson(result);
    else console.log(`Initialized ${options.config}`);
  });

program
  .command("doctor")
  .description("Validate local bridge setup")
  .option("-c, --config <path>", "config path", defaultConfigPath())
  .option("--json", "output JSON")
  .action(async (options) => {
    const report = await doctor(options.config);
    if (options.json) asJson(report);
    else {
      for (const check of report.checks) {
        console.log(`${check.ok ? "ok" : "fail"} ${check.name}${check.detail ? ` - ${check.detail}` : ""}`);
      }
      process.exitCode = report.ok ? 0 : 1;
    }
  });

const configCommand = program.command("config").description("Inspect bridge config");
configCommand.command("path").description("Print config path").action(() => console.log(defaultConfigPath()));
configCommand
  .command("show")
  .description("Print config")
  .option("-c, --config <path>", "config path", defaultConfigPath())
  .action(async (options) => asJson(await loadConfig(options.config)));

const channels = program.command("channels").description("Manage message channels");
channels.command("list").option("-c, --config <path>", "config path", defaultConfigPath()).option("--json", "output JSON").action(async (options) => {
  const config = await loadConfig(options.config);
  options.json ? asJson(config.channels) : printList(config.channels);
});
channels
  .command("add-telegram")
  .argument("<id>")
  .description("Add a Telegram bot channel")
  .option("--token-env <name>", "environment variable containing bot token", "TELEGRAM_BOT_TOKEN")
  .option("--default-chat-id <id>", "default chat id for bridge send")
  .option("--allowed-chat-ids <ids>", "comma-separated allowed chat ids")
  .option("--allow-all-chats", "explicitly allow every chat that can reach this bot")
  .option("-c, --config <path>", "config path", defaultConfigPath())
  .option("--json", "output JSON")
  .action(async (id, options) => {
    const allowedChatIds = splitCsv(options.allowedChatIds);
    if (!allowedChatIds?.length && !options.allowAllChats) {
      throw new Error("Telegram channels require --allowed-chat-ids or explicit --allow-all-chats");
    }
    const config = await upsertChannel({
      id,
      kind: "telegram",
      enabled: true,
      botTokenEnv: options.tokenEnv,
      defaultChatId: options.defaultChatId,
      allowedChatIds,
      allowAllChats: Boolean(options.allowAllChats),
    }, options.config);
    options.json ? asJson(config.channels[id]) : console.log(`Added telegram channel ${id}`);
  });
channels
  .command("add-console")
  .argument("<id>")
  .description("Add a console channel for local testing")
  .option("-c, --config <path>", "config path", defaultConfigPath())
  .option("--json", "output JSON")
  .action(async (id, options) => {
    const config = await upsertChannel({ id, kind: "console", enabled: true }, options.config);
    options.json ? asJson(config.channels[id]) : console.log(`Added console channel ${id}`);
  });

const profiles = program.command("profiles").description("Manage reusable agent profiles");
profiles.command("list").option("-c, --config <path>", "config path", defaultConfigPath()).option("--json", "output JSON").action(async (options) => {
  const config = await loadConfig(options.config);
  options.json ? asJson(config.profiles) : printList(config.profiles);
});
profiles
  .command("add")
  .argument("<id>")
  .requiredOption("--agent-kind <kind>", "codewith, claude, aicopilot, or shell")
  .option("--auth-profile <name>", "Codewith auth profile")
  .option("--cwd <path>", "default working directory")
  .option("--home <path>", "profile HOME override")
  .option("--command <command>", "custom command")
  .option("--arg <arg...>", "custom args; {prompt} is replaced")
  .option("--env <key=value...>", "environment values")
  .option("-c, --config <path>", "config path", defaultConfigPath())
  .option("--json", "output JSON")
  .action(async (id, options) => {
    const config = await upsertProfile({
      id,
      agentKind: options.agentKind as AgentKind,
      authProfile: options.authProfile,
      cwd: options.cwd,
      home: options.home,
      command: options.command,
      args: options.arg,
      env: parseEnv(options.env),
    }, options.config);
    options.json ? asJson(config.profiles[id]) : console.log(`Added profile ${id}`);
  });

const agents = program.command("agents").description("Manage bridge agent targets");
agents.command("list").option("-c, --config <path>", "config path", defaultConfigPath()).option("--json", "output JSON").action(async (options) => {
  const config = await loadConfig(options.config);
  options.json ? asJson(config.agents) : printList(config.agents);
});
agents
  .command("add")
  .argument("<id>")
  .requiredOption("--kind <kind>", "codewith, claude, aicopilot, or shell")
  .option("--profile <id>", "profile id")
  .option("--cwd <path>", "working directory")
  .option("--command <command>", "custom command")
  .option("--arg <arg...>", "custom args; {prompt} is replaced")
  .option("--env <key=value...>", "environment values")
  .option("--timeout-ms <n>", "agent timeout in milliseconds")
  .option("-c, --config <path>", "config path", defaultConfigPath())
  .option("--json", "output JSON")
  .action(async (id, options) => {
    const timeoutMs = options.timeoutMs ? Number.parseInt(options.timeoutMs, 10) : undefined;
    const config = await upsertAgent({
      id,
      kind: options.kind as AgentKind,
      profileId: options.profile,
      cwd: options.cwd,
      command: options.command,
      args: options.arg,
      env: parseEnv(options.env),
      timeoutMs,
    }, options.config);
    options.json ? asJson(config.agents[id]) : console.log(`Added agent ${id}`);
  });

const routes = program.command("routes").description("Manage channel-to-agent routes");
routes.command("list").option("-c, --config <path>", "config path", defaultConfigPath()).option("--json", "output JSON").action(async (options) => {
  const config = await loadConfig(options.config);
  options.json ? asJson(config.routes) : printList(config.routes);
});
routes
  .command("add")
  .argument("<id>")
  .requiredOption("--from <channel>", "source channel id")
  .requiredOption("--to <agent>", "destination agent id")
  .option("--response-channel <channel>", "response channel id")
  .option("--chat-ids <ids>", "comma-separated chat ids")
  .option("--text-regex <pattern>", "message text regex")
  .option("-c, --config <path>", "config path", defaultConfigPath())
  .option("--json", "output JSON")
  .action(async (id, options) => {
    const config = await upsertRoute({
      id,
      fromChannel: options.from,
      toAgent: options.to,
      responseChannel: options.responseChannel,
      enabled: true,
      match: {
        chatIds: splitCsv(options.chatIds),
        textRegex: options.textRegex,
      },
    }, options.config);
    options.json ? asJson(config.routes.find((route) => route.id === id)) : console.log(`Added route ${id}`);
  });

program
  .command("send")
  .argument("<channel>")
  .argument("[chatId]")
  .argument("[text...]")
  .description("Send a message through a channel")
  .option("-c, --config <path>", "config path", defaultConfigPath())
  .option("--json", "output JSON")
  .action(async (channelId, chatId, textParts, options) => {
    const config = await loadConfig(options.config);
    const channel = config.channels[channelId];
    if (!channel) throw new Error(`Channel not found: ${channelId}`);
    let targetChat = chatId as string | undefined;
    let text = (textParts as string[]).join(" ");
    if (channel.kind !== "telegram" && !text && targetChat) {
      text = targetChat;
      targetChat = undefined;
    }
    if (channel.kind === "telegram") {
      targetChat = targetChat || channel.defaultChatId;
      if (!targetChat) throw new Error("chatId argument or channel.defaultChatId is required");
      if (!channel.allowAllChats && !channel.allowedChatIds?.includes(targetChat)) {
        throw new Error(`Telegram chat ${targetChat} is not in channel allowedChatIds`);
      }
      const result = await sendTelegramMessage(telegramToken(channel), targetChat, text);
      options.json ? asJson(result) : console.log("sent");
      return;
    }
    if (channel.kind === "console") {
      if (options.json) asJson({ channel: channelId, text });
      else console.log(text);
      return;
    }
    throw new Error(`Sending through ${channel.kind} is not implemented yet`);
  });

program
  .command("ask")
  .argument("<agent>")
  .argument("<text...>")
  .description("Run one agent directly")
  .option("-c, --config <path>", "config path", defaultConfigPath())
  .option("--json", "output JSON")
  .action(async (agentId, textParts, options) => {
    const config = await loadConfig(options.config);
    const message: BridgeMessage = {
      id: `cli:${Date.now()}`,
      channelId: "cli",
      text: (textParts as string[]).join(" "),
      receivedAt: new Date().toISOString(),
    };
    const result = await runAgent(config, agentId, { message, route: { id: "cli", fromChannel: "cli", toAgent: agentId } });
    options.json ? asJson(result) : process.stdout.write(result.stdout || result.stderr);
    process.exitCode = result.exitCode ?? 1;
  });

program
  .command("serve")
  .description("Poll configured channels and route messages to agents")
  .option("--once", "poll once and exit")
  .option("--interval <ms>", "delay between polls", "1000")
  .option("-c, --config <path>", "config path", defaultConfigPath())
  .option("--state <path>", "state path", defaultStatePath())
  .option("--json", "emit routed message JSON")
  .action(runServe);

const daemon = program.command("daemon").description("Manage the bridge background daemon");

daemon
  .command("status")
  .description("Show daemon status")
  .option("--supervisor <type>", "process, launchd, systemd, or auto", "process")
  .option("--daemon-dir <path>", "daemon metadata/log directory")
  .option("--json", "output JSON")
  .action(async (options) => {
    const status = await daemonStatus({ supervisor: options.supervisor, daemonDir: options.daemonDir });
    if (options.json) asJson(status);
    else {
      console.log(`${status.running ? "running" : status.stale ? "stale" : "stopped"} ${status.supervisor}${status.pid ? ` pid=${status.pid}` : ""}`);
      console.log(`daemonDir=${status.paths.dir}`);
      console.log(`stdout=${status.paths.stdoutLog}`);
      console.log(`stderr=${status.paths.stderrLog}`);
      if (status.telegramApiBase.error) {
        console.log(`telegramApiBaseError=${status.telegramApiBase.error}`);
      } else if (status.telegramApiBase.overridden) {
        console.log(`telegramApiBase=${status.telegramApiBase.origin}${status.telegramApiBase.pathname}`);
      }
    }
  });

daemon
  .command("start")
  .description("Start bridge serve in the background")
  .option("--supervisor <type>", "process, launchd, systemd, or auto", "process")
  .option("--daemon-dir <path>", "daemon metadata/log directory")
  .option("--interval <ms>", "delay between polls", "1000")
  .option("-c, --config <path>", "config path", defaultConfigPath())
  .option("--state <path>", "state path", defaultStatePath())
  .option("--serve-json", "emit routed message JSON to daemon stdout log")
  .option("--json", "output JSON")
  .action(async (options) => {
    const intervalMs = parseNonNegativeInt(options.interval, "--interval");
    const supervisor = options.supervisor;
    const result = supervisor === "process"
      ? await startProcessDaemon({ daemonDir: options.daemonDir, configPath: options.config, statePath: options.state, intervalMs, serveJson: options.serveJson })
      : await startInstalledDaemon({ supervisor, daemonDir: options.daemonDir, configPath: options.config, statePath: options.state, intervalMs, serveJson: options.serveJson });
    options.json ? asJson(result) : console.log("started");
  });

daemon
  .command("stop")
  .description("Stop the bridge daemon")
  .option("--supervisor <type>", "process, launchd, systemd, or auto", "process")
  .option("--daemon-dir <path>", "daemon metadata/log directory")
  .option("--timeout-ms <ms>", "graceful stop timeout", "5000")
  .option("--force", "force kill after timeout")
  .option("--json", "output JSON")
  .action(async (options) => {
    const timeoutMs = parseNonNegativeInt(options.timeoutMs, "--timeout-ms");
    const result = options.supervisor === "process"
      ? await stopProcessDaemon({ daemonDir: options.daemonDir, timeoutMs, force: options.force })
      : await stopInstalledDaemon({ supervisor: options.supervisor, daemonDir: options.daemonDir, timeoutMs, force: options.force });
    options.json ? asJson(result || { stopped: true }) : console.log("stopped");
  });

daemon
  .command("restart")
  .description("Restart the bridge daemon")
  .option("--supervisor <type>", "process, launchd, systemd, or auto", "process")
  .option("--daemon-dir <path>", "daemon metadata/log directory")
  .option("--interval <ms>", "delay between polls")
  .option("-c, --config <path>", "config path")
  .option("--state <path>", "state path")
  .option("--serve-json", "emit routed message JSON to daemon stdout log")
  .option("--timeout-ms <ms>", "graceful stop timeout", "5000")
  .option("--force", "force kill after timeout")
  .option("--json", "output JSON")
  .action(async (options) => {
    const restartOptions = {
      supervisor: options.supervisor,
      daemonDir: options.daemonDir,
      configPath: options.config,
      statePath: options.state,
      intervalMs: options.interval ? parseNonNegativeInt(options.interval, "--interval") : undefined,
      serveJson: options.serveJson,
      timeoutMs: parseNonNegativeInt(options.timeoutMs, "--timeout-ms"),
      force: options.force,
    };
    const result = options.supervisor === "process"
      ? await restartProcessDaemon(restartOptions)
      : await restartInstalledDaemon(restartOptions);
    options.json ? asJson(result) : console.log("restarted");
  });

daemon
  .command("logs")
  .description("Print daemon logs")
  .option("--daemon-dir <path>", "daemon metadata/log directory")
  .option("--lines <n>", "number of lines", "100")
  .option("--follow", "follow logs")
  .option("--json", "output JSON")
  .action(async (options) => {
    const lines = parseNonNegativeInt(options.lines, "--lines") || 100;
    if (options.follow) {
      const paths = daemonPaths(options.daemonDir);
      const tail = Bun.spawn(["tail", "-n", String(lines), "-f", paths.stdoutLog, paths.stderrLog], {
        stdout: "inherit",
        stderr: "inherit",
      });
      await tail.exited;
      return;
    }
    const logs = await daemonLogs({ daemonDir: options.daemonDir, lines });
    if (options.json) asJson(logs);
    else {
      if (logs.stdout) console.log(logs.stdout);
      if (logs.stderr) console.error(logs.stderr);
    }
  });

daemon
  .command("install")
  .description("Write launchd or systemd user supervisor files")
  .option("--supervisor <type>", "launchd, systemd, or auto", "auto")
  .option("--daemon-dir <path>", "daemon metadata/log directory")
  .option("--interval <ms>", "delay between polls", "1000")
  .option("-c, --config <path>", "config path", defaultConfigPath())
  .option("--state <path>", "state path", defaultStatePath())
  .option("--serve-json", "emit routed message JSON to daemon stdout log")
  .option("--json", "output JSON")
  .action(async (options) => {
    const result = await installDaemon({
      supervisor: options.supervisor,
      daemonDir: options.daemonDir,
      configPath: options.config,
      statePath: options.state,
      intervalMs: parseNonNegativeInt(options.interval, "--interval"),
      serveJson: options.serveJson,
    });
    options.json ? asJson(result) : console.log(`installed ${result.supervisor}: ${result.path}`);
  });

daemon
  .command("uninstall")
  .description("Remove launchd/systemd supervisor files or process metadata")
  .option("--supervisor <type>", "process, launchd, systemd, or auto", "auto")
  .option("--daemon-dir <path>", "daemon metadata/log directory")
  .option("--json", "output JSON")
  .action(async (options) => {
    const result = await uninstallDaemon({ supervisor: options.supervisor, daemonDir: options.daemonDir });
    options.json ? asJson(result) : console.log(`removed ${result.removed.join(", ")}`);
  });

program
  .command("route-message")
  .description("Route one synthetic message; useful for tests and MCP-style probes")
  .requiredOption("--channel <id>", "source channel id")
  .requiredOption("--text <text>", "message text")
  .option("--chat-id <id>", "chat id")
  .option("--from <from>", "sender")
  .option("-c, --config <path>", "config path", defaultConfigPath())
  .option("--json", "output JSON")
  .action(async (options) => {
    const config = await loadConfig(options.config);
    const result = await routeMessage(config, {
      id: `cli:${Date.now()}`,
      channelId: options.channel,
      text: options.text,
      chatId: options.chatId,
      from: options.from,
      receivedAt: new Date().toISOString(),
    }, { writeConsole: options.json ? false : undefined });
    options.json ? asJson(result) : printList(result);
  });

await program.parseAsync(process.argv);
