import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { bridgeHome, defaultConfigPath } from "./paths.js";
import { defaultStatePath } from "./state.js";
import { telegramApiBaseInfo } from "./telegram.js";
import type { BridgeConfig, IMessageChannelConfig, TelegramChannelConfig } from "../types.js";

export type DaemonSupervisor = "process" | "launchd" | "systemd";
export type DaemonSupervisorOption = DaemonSupervisor | "auto";

export interface DaemonPaths {
  dir: string;
  lockDir: string;
  metadataFile: string;
  stdoutLog: string;
  stderrLog: string;
  launchdPlist: string;
  systemdUnit: string;
}

export interface DaemonMetadata {
  version: 1;
  supervisor: "process";
  pid: number;
  pgid?: number;
  startedAt: string;
  identity: {
    command: string;
    cwd: string;
    configPath: string;
    statePath: string;
    daemonDir: string;
    bridgeHome: string;
  };
  command: string[];
  cwd: string;
  configPath: string;
  statePath: string;
  intervalMs: number;
  serveJson: boolean;
  daemonDir: string;
  bridgeHome: string;
  stdoutLog: string;
  stderrLog: string;
}

export interface DaemonStatus {
  running: boolean;
  stale: boolean;
  supervisor: DaemonSupervisor;
  pid?: number;
  startedAt?: string;
  uptimeSeconds?: number;
  detail?: string;
  installedDetail?: string;
  metadata?: DaemonMetadata;
  paths: DaemonPaths;
  installed: {
    launchd: boolean;
    systemd: boolean;
  };
  telegramApiBase: {
    overridden: boolean;
    origin: string;
    pathname: string;
    error?: string;
  };
}

export interface DaemonStartOptions {
  supervisor?: DaemonSupervisorOption;
  daemonDir?: string;
  configPath?: string;
  statePath?: string;
  intervalMs?: number;
  serveJson?: boolean;
}

export interface DaemonStopOptions {
  supervisor?: DaemonSupervisorOption;
  daemonDir?: string;
  timeoutMs?: number;
  force?: boolean;
}

export interface DaemonInstallOptions {
  supervisor?: DaemonSupervisorOption;
  daemonDir?: string;
  configPath?: string;
  statePath?: string;
  intervalMs?: number;
  serveJson?: boolean;
}

export interface DaemonInstallResult {
  supervisor: DaemonSupervisor;
  path: string;
  command: string[];
  requiredEnv: string[];
  warning?: string;
}

function isNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}

function currentPlatformSupervisor(): DaemonSupervisor {
  if (process.platform === "darwin") return "launchd";
  if (process.platform === "linux") return "systemd";
  return "process";
}

export function resolveSupervisor(supervisor: DaemonSupervisorOption = "process"): DaemonSupervisor {
  return supervisor === "auto" ? currentPlatformSupervisor() : supervisor;
}

export function defaultDaemonDir(): string {
  return join(bridgeHome(), "daemon");
}

export function daemonPaths(daemonDir = defaultDaemonDir()): DaemonPaths {
  const dir = resolve(daemonDir);
  return {
    dir,
    lockDir: join(dir, "lock"),
    metadataFile: join(dir, "bridge-daemon.json"),
    stdoutLog: join(dir, "bridge.out.log"),
    stderrLog: join(dir, "bridge.err.log"),
    launchdPlist: join(process.env["HOME"] || process.cwd(), "Library", "LaunchAgents", "com.hasna.bridge.plist"),
    systemdUnit: join(process.env["HOME"] || process.cwd(), ".config", "systemd", "user", "hasna-bridge.service"),
  };
}

export async function ensureDaemonDir(dir = defaultDaemonDir()): Promise<DaemonPaths> {
  const paths = daemonPaths(dir);
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await chmod(paths.dir, 0o700);
  return paths;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

async function readMetadata(paths: DaemonPaths): Promise<DaemonMetadata | undefined> {
  try {
    return JSON.parse(await readFile(paths.metadataFile, "utf-8")) as DaemonMetadata;
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

async function writeMetadata(paths: DaemonPaths, metadata: DaemonMetadata): Promise<void> {
  const tmp = `${paths.metadataFile}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, paths.metadataFile);
  await chmod(paths.metadataFile, 0o600);
}

async function withDaemonLock<T>(paths: DaemonPaths, fn: () => Promise<T>): Promise<T> {
  try {
    await mkdir(paths.lockDir, { mode: 0o700 });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") {
      throw new Error(`Another bridge daemon operation is already running: ${paths.lockDir}`);
    }
    throw err;
  }

  try {
    return await fn();
  } finally {
    await rmdir(paths.lockDir).catch(() => undefined);
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function processCommand(pid: number): Promise<string | undefined> {
  const proc = Bun.spawn(["ps", "-p", String(pid), "-o", "command="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if ((await proc.exited) !== 0) return undefined;
  return (await new Response(proc.stdout).text()).trim();
}

async function processPgid(pid: number): Promise<number | undefined> {
  const proc = Bun.spawn(["ps", "-p", String(pid), "-o", "pgid="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if ((await proc.exited) !== 0) return undefined;
  const parsed = Number.parseInt((await new Response(proc.stdout).text()).trim(), 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandPattern(command: string[]): string {
  return command.map(shellQuote).join(" ");
}

async function processMatches(metadata: DaemonMetadata): Promise<boolean> {
  if (!pidAlive(metadata.pid)) return false;
  const command = await processCommand(metadata.pid);
  if (!command) return false;
  if (!metadata.pgid) return false;
  const pgid = await processPgid(metadata.pid);
  if (pgid !== metadata.pgid) return false;
  const requiredArgs = [
    metadata.command[1],
    "serve",
    "--config",
    metadata.configPath,
    "--state",
    metadata.statePath,
    "--interval",
    String(metadata.intervalMs),
  ].filter((arg): arg is string => Boolean(arg));
  if (metadata.serveJson) requiredArgs.push("--json");
  return requiredArgs.every((arg) => command.includes(arg));
}

async function removeMetadata(paths: DaemonPaths): Promise<void> {
  await rm(paths.metadataFile, { force: true });
}

function safeTelegramApiBaseInfo(): DaemonStatus["telegramApiBase"] {
  try {
    return telegramApiBaseInfo();
  } catch (err) {
    return {
      overridden: true,
      origin: "",
      pathname: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function startCommand(options: Required<Pick<DaemonStartOptions, "configPath" | "statePath" | "intervalMs" | "serveJson">>): string[] {
  const scriptPath = process.argv[1];
  const base = scriptPath ? [process.execPath, scriptPath] : ["bridge"];
  const command = [
    ...base,
    "serve",
    "--config",
    options.configPath,
    "--state",
    options.statePath,
    "--interval",
    String(options.intervalMs),
  ];
  if (options.serveJson) command.push("--json");
  return command;
}

function telegramChannels(config: BridgeConfig): TelegramChannelConfig[] {
  return Object.values(config.channels).filter(
    (channel): channel is TelegramChannelConfig => channel.kind === "telegram" && channel.enabled !== false,
  );
}

function imessagePollChannels(config: BridgeConfig): IMessageChannelConfig[] {
  return Object.values(config.channels).filter(
    (channel): channel is IMessageChannelConfig => channel.kind === "imessage" && channel.enabled !== false && channel.receiveMode === "chat-db",
  );
}

export function requiredTelegramEnvVars(config: BridgeConfig): string[] {
  return [...new Set(telegramChannels(config).map((channel) => channel.botTokenEnv || "TELEGRAM_BOT_TOKEN"))];
}

async function validateStartConfig(configPath: string): Promise<void> {
  const config = await loadConfig(configPath);
  const channels = [...telegramChannels(config), ...imessagePollChannels(config)];
  if (!channels.length) throw new Error("No enabled pollable channels configured; add Telegram or iMessage receive before starting the daemon");
  for (const envName of requiredTelegramEnvVars(config)) {
    if (!process.env[envName]) throw new Error(`Missing Telegram bot token env var for daemon start: ${envName}`);
  }
}

function openPrivateLog(path: string): number {
  const fd = openSync(path, "a", 0o600);
  return fd;
}

async function ensurePrivateLogFiles(paths: DaemonPaths): Promise<void> {
  for (const path of [paths.stdoutLog, paths.stderrLog]) {
    const fd = openPrivateLog(path);
    closeSync(fd);
    await chmod(path, 0o600);
  }
}

async function runCapture(command: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function installedSupervisorStatus(supervisor: DaemonSupervisor, paths: DaemonPaths): Promise<{ running: boolean; detail: string }> {
  if (supervisor === "launchd") {
    if (!(await fileExists(paths.launchdPlist))) return { running: false, detail: "launchd plist not installed" };
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid === undefined) return { running: false, detail: "launchd status requires a numeric uid" };
    const result = await runCapture(["launchctl", "print", `gui/${uid}/com.hasna.bridge`]);
    if (result.exitCode !== 0) return { running: false, detail: result.stderr.trim() || result.stdout.trim() || "launchd service not loaded" };
    const running = /state\s*=\s*running/.test(result.stdout);
    return { running, detail: running ? "launchd running" : "launchd loaded but not running" };
  }

  if (supervisor === "systemd") {
    if (!(await fileExists(paths.systemdUnit))) return { running: false, detail: "systemd unit not installed" };
    const result = await runCapture(["systemctl", "--user", "is-active", "hasna-bridge.service"]);
    const state = result.stdout.trim() || result.stderr.trim() || "unknown";
    return { running: result.exitCode === 0 && state === "active", detail: `systemd ${state}` };
  }

  return { running: false, detail: "process supervisor has no installed status" };
}

export async function daemonStatus(options: { daemonDir?: string; supervisor?: DaemonSupervisorOption } = {}): Promise<DaemonStatus> {
  const supervisor = resolveSupervisor(options.supervisor);
  const paths = daemonPaths(options.daemonDir);
  const metadata = await readMetadata(paths);
  const live = metadata ? await processMatches(metadata) : false;
  const stale = Boolean(metadata && !live);
  const startedAt = metadata?.startedAt;
  const uptimeSeconds = live && startedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000)) : undefined;
  const installed = {
    launchd: await fileExists(paths.launchdPlist),
    systemd: await fileExists(paths.systemdUnit),
  };
  const installedRuntime = supervisor === "process" ? undefined : await installedSupervisorStatus(supervisor, paths);
  return {
    running: installedRuntime ? installedRuntime.running : live,
    stale: installedRuntime ? false : stale,
    supervisor,
    pid: metadata?.pid,
    startedAt,
    uptimeSeconds,
    detail: installedRuntime?.detail || (stale ? "stale process metadata" : live ? "running" : "not running"),
    installedDetail: installedRuntime?.detail,
    metadata,
    paths,
    installed,
    telegramApiBase: safeTelegramApiBaseInfo(),
  };
}

export async function startProcessDaemon(options: DaemonStartOptions = {}): Promise<DaemonStatus> {
  const paths = await ensureDaemonDir(options.daemonDir);
  return withDaemonLock(paths, async () => {
    const existing = await daemonStatus({ daemonDir: paths.dir, supervisor: "process" });
    if (existing.running) return existing;
    if (existing.stale) await removeMetadata(paths);

    const configPath = resolve(options.configPath || defaultConfigPath());
    const statePath = resolve(options.statePath || defaultStatePath());
    const intervalMs = options.intervalMs ?? 1000;
    const serveJson = Boolean(options.serveJson);
    if (!Number.isInteger(intervalMs) || intervalMs < 0) throw new Error("--interval must be a non-negative integer");
    await validateStartConfig(configPath);

    const stdoutFd = openPrivateLog(paths.stdoutLog);
    const stderrFd = openPrivateLog(paths.stderrLog);
    try {
      const command = startCommand({ configPath, statePath, intervalMs, serveJson });
      const child = spawn(command[0]!, command.slice(1), {
        cwd: process.cwd(),
        detached: true,
        env: process.env,
        stdio: ["ignore", stdoutFd, stderrFd],
      });
      child.unref();

      const metadata: DaemonMetadata = {
        version: 1,
        supervisor: "process",
        pid: child.pid || 0,
        pgid: child.pid || undefined,
        startedAt: new Date().toISOString(),
        identity: {
          command: commandPattern(command),
          cwd: process.cwd(),
          configPath,
          statePath,
          daemonDir: paths.dir,
          bridgeHome: bridgeHome(),
        },
        command,
        cwd: process.cwd(),
        configPath,
        statePath,
        intervalMs,
        serveJson,
        daemonDir: paths.dir,
        bridgeHome: bridgeHome(),
        stdoutLog: paths.stdoutLog,
        stderrLog: paths.stderrLog,
      };
      if (!metadata.pid) throw new Error("Failed to start bridge daemon process");
      await writeMetadata(paths, metadata);
      await Bun.sleep(200);
      const status = await daemonStatus({ daemonDir: paths.dir, supervisor: "process" });
      if (!status.running) {
        await removeMetadata(paths);
        throw new Error(`Bridge daemon failed to stay running; inspect ${paths.stderrLog}`);
      }
      return status;
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
      await chmod(paths.stdoutLog, 0o600).catch(() => undefined);
      await chmod(paths.stderrLog, 0o600).catch(() => undefined);
    }
  });
}

async function stopPid(pid: number, force: boolean): Promise<void> {
  process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!pidAlive(pid)) return true;
    await Bun.sleep(100);
  }
  return !pidAlive(pid);
}

export async function stopProcessDaemon(options: DaemonStopOptions = {}): Promise<DaemonStatus> {
  const paths = await ensureDaemonDir(options.daemonDir);
  return withDaemonLock(paths, async () => {
    const metadata = await readMetadata(paths);
    if (!metadata) return daemonStatus({ daemonDir: paths.dir, supervisor: "process" });

    if (!(await processMatches(metadata))) {
      await removeMetadata(paths);
      return daemonStatus({ daemonDir: paths.dir, supervisor: "process" });
    }

    await stopPid(metadata.pid, false);
    let exited = await waitForExit(metadata.pid, options.timeoutMs ?? 5000);
    if (!exited && options.force) {
      await stopPid(metadata.pid, true);
      exited = await waitForExit(metadata.pid, 2000);
    }
    if (!exited) throw new Error(`Bridge daemon did not stop within ${options.timeoutMs ?? 5000}ms`);
    await removeMetadata(paths);
    return daemonStatus({ daemonDir: paths.dir, supervisor: "process" });
  });
}

export async function restartProcessDaemon(options: DaemonStartOptions & DaemonStopOptions = {}): Promise<DaemonStatus> {
  const paths = daemonPaths(options.daemonDir);
  const metadata = await readMetadata(paths);
  await stopProcessDaemon(options);
  return startProcessDaemon({
    ...options,
    configPath: options.configPath || metadata?.configPath,
    statePath: options.statePath || metadata?.statePath,
    intervalMs: options.intervalMs ?? metadata?.intervalMs,
    serveJson: options.serveJson ?? metadata?.serveJson,
  });
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function plistArray(values: string[]): string {
  return values.map((value) => `    <string>${xmlEscape(value)}</string>`).join("\n");
}

export function renderLaunchdPlist(command: string[], paths: DaemonPaths): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.hasna.bridge</string>
  <key>ProgramArguments</key>
  <array>
${plistArray(command)}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(paths.stdoutLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(paths.stderrLog)}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(process.cwd())}</string>
</dict>
</plist>
`;
}

function systemdEscape(value: string): string {
  return value.replaceAll("%", "%%").replaceAll("\n", " ");
}

function systemdQuote(value: string): string {
  return `"${systemdEscape(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

export function renderSystemdUnit(command: string[], paths: DaemonPaths): string {
  return `[Unit]
Description=Hasna Bridge daemon
After=network-online.target

[Service]
Type=simple
ExecStart=${command.map(systemdQuote).join(" ")}
Restart=always
RestartSec=5
WorkingDirectory=${systemdEscape(process.cwd())}
StandardOutput=append:${systemdEscape(paths.stdoutLog)}
StandardError=append:${systemdEscape(paths.stderrLog)}

[Install]
WantedBy=default.target
`;
}

async function installFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { encoding: "utf-8", mode: 0o600 });
  await chmod(path, 0o600);
}

export async function installDaemon(options: DaemonInstallOptions = {}): Promise<DaemonInstallResult> {
  const supervisor = resolveSupervisor(options.supervisor || "auto");
  if (supervisor === "process") {
    throw new Error("The process supervisor does not need install; use `bridge daemon start`");
  }

  const paths = await ensureDaemonDir(options.daemonDir);
  await ensurePrivateLogFiles(paths);
  const configPath = resolve(options.configPath || defaultConfigPath());
  const statePath = resolve(options.statePath || defaultStatePath());
  const intervalMs = options.intervalMs ?? 1000;
  const serveJson = Boolean(options.serveJson);
  const command = startCommand({ configPath, statePath, intervalMs, serveJson });
  const config = await loadConfig(configPath);
  const requiredEnv = requiredTelegramEnvVars(config);

  if (supervisor === "launchd") {
    await installFile(paths.launchdPlist, renderLaunchdPlist(command, paths));
    return {
      supervisor,
      path: paths.launchdPlist,
      command,
      requiredEnv,
      warning: "Telegram token values are not written to launchd files. Set them in the launchd environment before starting.",
    };
  }

  await installFile(paths.systemdUnit, renderSystemdUnit(command, paths));
  return {
    supervisor,
    path: paths.systemdUnit,
    command,
    requiredEnv,
    warning: "Telegram token values are not written to systemd files. Import them into the user manager environment before starting.",
  };
}

async function runCommand(command: string[]): Promise<void> {
  const { exitCode, stdout, stderr } = await runCapture(command);
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed (${exitCode}): ${stderr || stdout}`);
}

async function waitForInstalledRunning(supervisor: DaemonSupervisor, paths: DaemonPaths, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < timeoutMs) {
    const status = await installedSupervisorStatus(supervisor, paths);
    last = status.detail;
    if (status.running) return;
    await Bun.sleep(250);
  }
  throw new Error(`${supervisor} service did not report running: ${last}`);
}

export async function startInstalledDaemon(options: DaemonInstallOptions = {}): Promise<DaemonInstallResult> {
  const result = await installDaemon(options);
  const paths = daemonPaths(options.daemonDir);
  if (result.supervisor === "launchd") {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid === undefined) throw new Error("launchd start requires a numeric uid");
    await runCommand(["launchctl", "bootstrap", `gui/${uid}`, result.path]).catch(async (err) => {
      if (!String(err).includes("Input/output error")) throw err;
      await runCommand(["launchctl", "kickstart", "-k", `gui/${uid}/com.hasna.bridge`]);
    });
    await waitForInstalledRunning(result.supervisor, paths);
    return result;
  }
  await runCommand(["systemctl", "--user", "daemon-reload"]);
  await runCommand(["systemctl", "--user", "enable", "--now", "hasna-bridge.service"]);
  await waitForInstalledRunning(result.supervisor, paths);
  return result;
}

export async function stopInstalledDaemon(options: DaemonStopOptions = {}): Promise<void> {
  const supervisor = resolveSupervisor(options.supervisor || "auto");
  const paths = daemonPaths(options.daemonDir);
  if (supervisor === "launchd") {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid === undefined) throw new Error("launchd stop requires a numeric uid");
    await runCommand(["launchctl", "bootout", `gui/${uid}`, paths.launchdPlist]);
    return;
  }
  if (supervisor === "systemd") {
    await runCommand(["systemctl", "--user", "disable", "--now", "hasna-bridge.service"]);
    return;
  }
  await stopProcessDaemon(options);
}

export async function restartInstalledDaemon(options: DaemonInstallOptions & DaemonStopOptions = {}): Promise<DaemonInstallResult | DaemonStatus> {
  const supervisor = resolveSupervisor(options.supervisor || "auto");
  if (supervisor === "process") return restartProcessDaemon(options);
  await stopInstalledDaemon({ ...options, supervisor }).catch(() => undefined);
  return startInstalledDaemon({ ...options, supervisor });
}

export async function uninstallDaemon(options: { supervisor?: DaemonSupervisorOption; daemonDir?: string } = {}): Promise<{ supervisor: DaemonSupervisor; removed: string[] }> {
  const supervisor = resolveSupervisor(options.supervisor || "auto");
  const paths = daemonPaths(options.daemonDir);
  const removed: string[] = [];
  if (supervisor === "launchd") {
    await stopInstalledDaemon({ ...options, supervisor }).catch(() => undefined);
    await rm(paths.launchdPlist, { force: true });
    removed.push(paths.launchdPlist);
  } else if (supervisor === "systemd") {
    await stopInstalledDaemon({ ...options, supervisor }).catch(() => undefined);
    await rm(paths.systemdUnit, { force: true });
    await runCommand(["systemctl", "--user", "daemon-reload"]).catch(() => undefined);
    removed.push(paths.systemdUnit);
  } else {
    await stopProcessDaemon({ ...options, supervisor }).catch(() => undefined);
    await removeMetadata(paths);
    removed.push(paths.metadataFile);
  }
  return { supervisor, removed };
}

export async function tailFile(path: string, lines: number): Promise<string> {
  try {
    const raw = await readFile(path, "utf-8");
    return raw.split(/\r?\n/).slice(-Math.max(1, lines)).join("\n");
  } catch (err) {
    if (isNotFound(err)) return "";
    throw err;
  }
}

export async function daemonLogs(options: { daemonDir?: string; lines?: number } = {}): Promise<{ stdout: string; stderr: string; paths: DaemonPaths }> {
  const paths = daemonPaths(options.daemonDir);
  const lines = options.lines ?? 100;
  return {
    stdout: await tailFile(paths.stdoutLog, lines),
    stderr: await tailFile(paths.stderrLog, lines),
    paths,
  };
}
