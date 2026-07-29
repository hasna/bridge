import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
  resume?: boolean;
  maxAttempts?: number;
  daemonDir: string;
  bridgeHome: string;
  stdoutLog: string;
  stderrLog: string;
}

export interface DaemonStatus {
  running: boolean;
  stale: boolean;
  /** True when this call removed metadata left behind by a daemon that is gone. */
  reaped: boolean;
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
  /** Pass `--resume` to serve so durable in-flight state is reconciled on start. Defaults to true. */
  resume?: boolean;
  /** Pass `--max-attempts` to serve. */
  maxAttempts?: number;
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
  resume?: boolean;
  maxAttempts?: number;
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

/**
 * A daemon operation (start/stop/restart) never legitimately runs this long.
 * Past it the lock is assumed abandoned even if its recorded owner pid still
 * resolves to a live process, because pids get recycled.
 */
const LOCK_MAX_AGE_MS = 120_000;

/** Grace window after metadata is written before it may be treated as stale. */
const REAP_GRACE_MS = 5_000;

interface DaemonLockOwner {
  pid: number;
  acquiredAt: string;
}

function hasCode(err: unknown, code: string): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === code);
}

function lockOwnerFile(paths: DaemonPaths): string {
  return join(paths.lockDir, "owner.json");
}

async function readLockOwner(paths: DaemonPaths): Promise<DaemonLockOwner | undefined> {
  try {
    const parsed = JSON.parse(await readFile(lockOwnerFile(paths), "utf-8")) as Partial<DaemonLockOwner>;
    if (!isSignalablePid(parsed.pid)) return undefined;
    return { pid: parsed.pid, acquiredAt: String(parsed.acquiredAt ?? "") };
  } catch {
    return undefined;
  }
}

/**
 * Break a lock directory left behind by a process that died before its `finally`
 * ran (SIGKILL, power loss, OOM kill). Without this, one crashed `bridge daemon
 * start` wedges every later start/stop/restart with no recovery short of
 * deleting the directory by hand.
 *
 * The lock is moved aside with a single atomic rename so that two racing callers
 * cannot both "break" the lock and then both believe they hold it.
 */
async function breakAbandonedDaemonLock(paths: DaemonPaths): Promise<boolean> {
  const info = await stat(paths.lockDir).catch(() => undefined);
  if (!info) return true;
  const ageMs = Date.now() - info.mtimeMs;
  const owner = await readLockOwner(paths);
  const expired = ageMs > LOCK_MAX_AGE_MS;
  const ownerGone = owner ? owner.pid !== process.pid && !pidAlive(owner.pid) : false;
  if (!expired && !ownerGone) return false;

  const abandoned = `${paths.lockDir}.abandoned.${process.pid}.${Date.now()}`;
  try {
    await rename(paths.lockDir, abandoned);
  } catch (err) {
    if (hasCode(err, "ENOENT")) return true;
    throw err;
  }
  await rm(abandoned, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

async function acquireDaemonLock(paths: DaemonPaths): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(paths.lockDir, { mode: 0o700 });
      await chmod(paths.lockDir, 0o700).catch(() => undefined);
      const owner: DaemonLockOwner = { pid: process.pid, acquiredAt: new Date().toISOString() };
      await writeFile(lockOwnerFile(paths), `${JSON.stringify(owner)}\n`, { encoding: "utf-8", mode: 0o600 }).catch(() => undefined);
      return;
    } catch (err) {
      if (!hasCode(err, "EEXIST")) throw err;
      if (attempt === 0 && await breakAbandonedDaemonLock(paths)) continue;
      const owner = await readLockOwner(paths);
      throw new Error(
        `Another bridge daemon operation is already running: ${paths.lockDir}` +
        (owner ? ` (held by pid ${owner.pid} since ${owner.acquiredAt})` : ""),
      );
    }
  }
}

async function releaseDaemonLock(paths: DaemonPaths): Promise<void> {
  // Only drop the lock if it is still ours. If a long operation overran
  // LOCK_MAX_AGE_MS another caller may have taken over, and removing its lock
  // would let a third caller in alongside it.
  const owner = await readLockOwner(paths);
  if (owner && owner.pid !== process.pid) return;
  await rm(paths.lockDir, { recursive: true, force: true }).catch(() => undefined);
}

async function withDaemonLock<T>(paths: DaemonPaths, fn: () => Promise<T>): Promise<T> {
  await acquireDaemonLock(paths);
  try {
    return await fn();
  } finally {
    await releaseDaemonLock(paths);
  }
}

/** Try to take the lock without failing the caller when it is genuinely busy. */
async function tryWithDaemonLock<T>(paths: DaemonPaths, fn: () => Promise<T>): Promise<{ locked: true; value: T } | { locked: false }> {
  try {
    await acquireDaemonLock(paths);
  } catch {
    return { locked: false };
  }
  try {
    return { locked: true, value: await fn() };
  } finally {
    await releaseDaemonLock(paths);
  }
}

/**
 * pid 0 and negative pids are process-*group* selectors for `kill(2)`: pid 0
 * means "every process in my own group". Treating a corrupt metadata pid as a
 * real process would make bridge signal the shell that invoked it, so anything
 * that is not a plain child pid is rejected outright.
 */
function isSignalablePid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 1;
}

function pidAlive(pid: number): boolean {
  if (!isSignalablePid(pid)) return false;
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
  if (!isSignalablePid(metadata.pid)) return false;
  if (!pidAlive(metadata.pid)) return false;
  const command = await processCommand(metadata.pid);
  if (!command) return false;
  // `startProcessDaemon` spawns detached, so a bridge daemon is always the
  // leader of its own process group. Metadata claiming any other group cannot
  // be trusted: `stopPid` signals the whole group, and honouring a foreign
  // pgid would mean SIGTERMing an unrelated group (potentially the caller's).
  if (!isSignalablePid(metadata.pgid) || metadata.pgid !== metadata.pid) return false;
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

export interface DaemonReapResult {
  reaped: boolean;
  /** Why nothing was reaped, when `reaped` is false. */
  reason?: "no metadata" | "running" | "within start grace period" | "locked" | "metadata changed";
  pid?: number;
}

export interface DaemonReapOptions {
  daemonDir?: string;
  /**
   * How recently metadata may have been written and still be reaped. Metadata is
   * written before the child has finished establishing its process group, so a
   * concurrent `status` must not mistake a starting daemon for a dead one.
   */
  graceMs?: number;
}

/**
 * Remove daemon metadata whose process is gone.
 *
 * `start` already did this, so anything that crashed without going through
 * `stop` left `status` and `doctor` reporting `stale pid=N` forever. Reaping is
 * done under the daemon lock and the metadata is re-read and re-verified while
 * held, so a daemon that starts concurrently is never orphaned by a reader.
 */
export async function reapStaleDaemonMetadata(options: DaemonReapOptions = {}): Promise<DaemonReapResult> {
  const paths = daemonPaths(options.daemonDir);
  const graceMs = options.graceMs ?? REAP_GRACE_MS;
  const observed = await readMetadata(paths);
  if (!observed) return { reaped: false, reason: "no metadata" };
  if (await processMatches(observed)) return { reaped: false, reason: "running", pid: observed.pid };

  // The grace window protects a daemon whose *identity* is not yet
  // establishable (metadata is written before the child has finished setting up
  // its process group). A pid that does not exist at all cannot be starting, so
  // a crashed daemon is reaped immediately rather than after the window.
  if (pidAlive(observed.pid)) {
    const startedAt = Date.parse(observed.startedAt ?? "");
    if (Number.isFinite(startedAt) && Date.now() - startedAt < graceMs) {
      return { reaped: false, reason: "within start grace period", pid: observed.pid };
    }
  }

  const outcome = await tryWithDaemonLock(paths, async (): Promise<DaemonReapResult> => {
    const current = await readMetadata(paths);
    if (!current) return { reaped: false, reason: "no metadata" };
    if (current.pid !== observed.pid || current.startedAt !== observed.startedAt) {
      return { reaped: false, reason: "metadata changed", pid: current.pid };
    }
    if (await processMatches(current)) return { reaped: false, reason: "running", pid: current.pid };
    await removeMetadata(paths);
    return { reaped: true, pid: current.pid };
  });

  return outcome.locked ? outcome.value : { reaped: false, reason: "locked", pid: observed.pid };
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

function startCommand(options: Required<Pick<DaemonStartOptions, "configPath" | "statePath" | "intervalMs" | "serveJson">> & Pick<DaemonStartOptions, "resume" | "maxAttempts">): string[] {
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
  if (options.resume !== false) command.push("--resume");
  if (options.maxAttempts !== undefined) command.push("--max-attempts", String(options.maxAttempts));
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

export interface DaemonStatusOptions {
  daemonDir?: string;
  supervisor?: DaemonSupervisorOption;
  /**
   * Remove metadata for a daemon that is gone (default true), so `status` and
   * `doctor` self-heal instead of reporting `stale` forever. Callers that hold
   * the daemon lock, or that want a pure read, pass false.
   */
  reap?: boolean;
}

export async function daemonStatus(options: DaemonStatusOptions = {}): Promise<DaemonStatus> {
  const supervisor = resolveSupervisor(options.supervisor);
  const paths = daemonPaths(options.daemonDir);
  const reap = options.reap !== false && supervisor === "process";

  let metadata = await readMetadata(paths);
  let live = metadata ? await processMatches(metadata) : false;
  let reapResult: DaemonReapResult | undefined;
  if (reap && metadata && !live) {
    reapResult = await reapStaleDaemonMetadata({ daemonDir: paths.dir });
    if (reapResult.reaped) {
      metadata = undefined;
    } else if (reapResult.reason !== "within start grace period" && reapResult.reason !== "locked") {
      // The record changed underneath us (a daemon started, or another process
      // reaped it). Re-observe rather than report the record we first read.
      metadata = await readMetadata(paths);
      live = metadata ? await processMatches(metadata) : false;
    }
  }
  const stale = Boolean(metadata && !live);
  const startedAt = metadata?.startedAt;
  const startedAtMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const uptimeSeconds = live && Number.isFinite(startedAtMs)
    ? Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000))
    : undefined;
  const installed = {
    launchd: await fileExists(paths.launchdPlist),
    systemd: await fileExists(paths.systemdUnit),
  };
  const installedRuntime = supervisor === "process" ? undefined : await installedSupervisorStatus(supervisor, paths);
  const processDetail = stale
    ? reapResult?.reason === "locked"
      ? "stale process metadata (not reaped: another daemon operation is in progress)"
      : reapResult?.reason === "within start grace period"
        ? "starting"
        : "stale process metadata"
    : live
      ? "running"
      : reapResult?.reaped
        ? `reaped stale process metadata (pid=${reapResult.pid})`
        : "not running";
  return {
    running: installedRuntime ? installedRuntime.running : live,
    stale: installedRuntime ? false : stale,
    reaped: Boolean(reapResult?.reaped),
    supervisor,
    pid: metadata?.pid,
    startedAt,
    uptimeSeconds,
    detail: installedRuntime?.detail || processDetail,
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
    // reap:false — we already hold the lock, and stale metadata is removed below.
    const existing = await daemonStatus({ daemonDir: paths.dir, supervisor: "process", reap: false });
    if (existing.running) return existing;
    if (existing.stale) await removeMetadata(paths);

    const configPath = resolve(options.configPath || defaultConfigPath());
    const statePath = resolve(options.statePath || defaultStatePath());
    const intervalMs = options.intervalMs ?? 1000;
    const serveJson = Boolean(options.serveJson);
    const resume = options.resume !== false;
    const maxAttempts = options.maxAttempts;
    if (!Number.isInteger(intervalMs) || intervalMs < 0) throw new Error("--interval must be a non-negative integer");
    await validateStartConfig(configPath);

    const stdoutFd = openPrivateLog(paths.stdoutLog);
    const stderrFd = openPrivateLog(paths.stderrLog);
    try {
      const command = startCommand({ configPath, statePath, intervalMs, serveJson, resume, maxAttempts });
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
        resume,
        maxAttempts,
        daemonDir: paths.dir,
        bridgeHome: bridgeHome(),
        stdoutLog: paths.stdoutLog,
        stderrLog: paths.stderrLog,
      };
      if (!isSignalablePid(metadata.pid)) throw new Error("Failed to start bridge daemon process");
      await writeMetadata(paths, metadata);
      await Bun.sleep(200);
      const status = await daemonStatus({ daemonDir: paths.dir, supervisor: "process", reap: false });
      if (!status.running) {
        // The child may still be alive but unidentifiable (e.g. it has not
        // established its process group yet). Dropping the metadata without
        // killing it would leave an unmanaged bridge polling Telegram forever
        // with no record of how to stop it.
        await killDaemonProcessGroup(metadata.pid).catch(() => undefined);
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
  // Guarded so a corrupt pid can never turn into kill(0, …) — "signal my own
  // process group", i.e. the user's shell.
  if (!isSignalablePid(pid)) throw new Error(`Refusing to signal invalid daemon pid: ${pid}`);
  process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
}

/** Best-effort teardown of a daemon we started but can no longer account for. */
async function killDaemonProcessGroup(pid: number): Promise<void> {
  if (!isSignalablePid(pid) || !pidAlive(pid)) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    process.kill(pid, "SIGTERM");
  }
  if (await waitForExit(pid, 2000)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    process.kill(pid, "SIGKILL");
  }
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
    if (!metadata) return daemonStatus({ daemonDir: paths.dir, supervisor: "process", reap: false });

    if (!(await processMatches(metadata))) {
      await removeMetadata(paths);
      return daemonStatus({ daemonDir: paths.dir, supervisor: "process", reap: false });
    }

    await stopPid(metadata.pid, false);
    let exited = await waitForExit(metadata.pid, options.timeoutMs ?? 5000);
    if (!exited && options.force) {
      await stopPid(metadata.pid, true);
      exited = await waitForExit(metadata.pid, 2000);
    }
    if (!exited) throw new Error(`Bridge daemon did not stop within ${options.timeoutMs ?? 5000}ms`);
    await removeMetadata(paths);
    return daemonStatus({ daemonDir: paths.dir, supervisor: "process", reap: false });
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
    resume: options.resume ?? metadata?.resume,
    maxAttempts: options.maxAttempts ?? metadata?.maxAttempts,
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
  const command = startCommand({ configPath, statePath, intervalMs, serveJson, resume: options.resume, maxAttempts: options.maxAttempts });
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

/** Upper bound on how much of a log file a single tail may pull into memory. */
const TAIL_MAX_BYTES = 4 * 1024 * 1024;

export async function tailFile(path: string, lines: number): Promise<string> {
  const wanted = Math.max(1, lines);
  let handle;
  try {
    handle = await open(path, "r");
  } catch (err) {
    if (isNotFound(err)) return "";
    throw err;
  }

  try {
    // Daemon logs are append-only and never rotated, so reading the whole file
    // to show the last few lines can mean loading gigabytes. Read only the tail.
    const size = (await handle.stat()).size;
    const length = Math.min(size, TAIL_MAX_BYTES);
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, size - length);
    const raw = buffer.toString("utf-8");

    const split = raw.split(/\r?\n/);
    // A log file ends with a newline, which yields a trailing empty element.
    // Counting it as a line silently returned one fewer line than requested.
    if (split.length > 1 && split[split.length - 1] === "") split.pop();
    // When the window starts mid-file its first element is a line fragment.
    if (length < size && split.length > 1) split.shift();
    return split.slice(-wanted).join("\n");
  } finally {
    await handle.close();
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
