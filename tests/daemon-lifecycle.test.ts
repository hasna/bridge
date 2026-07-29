import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  daemonPaths,
  daemonStatus,
  reapStaleDaemonMetadata,
  stopProcessDaemon,
  tailFile,
  type DaemonMetadata,
} from "../src/index.js";

const spawned: Array<{ kill: (signal?: number | NodeJS.Signals) => void }> = [];

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
});

async function scratchDaemonDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bridge-lifecycle-"));
  const daemonDir = join(dir, "daemon");
  await mkdir(daemonDir, { recursive: true, mode: 0o700 });
  return daemonDir;
}

function metadataFor(daemonDir: string, overrides: Partial<DaemonMetadata> = {}): DaemonMetadata {
  const paths = daemonPaths(daemonDir);
  return {
    version: 1,
    supervisor: "process",
    pid: 999999,
    pgid: 999999,
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    identity: {
      command: "'bridge' 'serve'",
      cwd: process.cwd(),
      configPath: "/tmp/config.json",
      statePath: "/tmp/state.json",
      daemonDir,
      bridgeHome: daemonDir,
    },
    command: ["bridge", "serve", "--config", "/tmp/config.json", "--state", "/tmp/state.json", "--interval", "1000"],
    cwd: process.cwd(),
    configPath: "/tmp/config.json",
    statePath: "/tmp/state.json",
    intervalMs: 1000,
    serveJson: false,
    daemonDir,
    bridgeHome: daemonDir,
    stdoutLog: paths.stdoutLog,
    stderrLog: paths.stderrLog,
    ...overrides,
  };
}

async function writeMetadataFile(daemonDir: string, overrides: Partial<DaemonMetadata> = {}): Promise<string> {
  const paths = daemonPaths(daemonDir);
  await writeFile(paths.metadataFile, `${JSON.stringify(metadataFor(daemonDir, overrides), null, 2)}\n`, { mode: 0o600 });
  return paths.metadataFile;
}

// ─── Defect: stale metadata is detected but never reaped outside `start` ──────

test("daemonStatus reaps stale daemon metadata", async () => {
  const daemonDir = await scratchDaemonDir();
  const metadataFile = await writeMetadataFile(daemonDir);

  const status = await daemonStatus({ daemonDir });

  expect(status.running).toBe(false);
  expect(status.stale).toBe(false);
  expect(status.reaped).toBe(true);
  expect(await Bun.file(metadataFile).exists()).toBe(false);

  const again = await daemonStatus({ daemonDir });
  expect(again.reaped).toBe(false);
  expect(again.detail).toBe("not running");
});

test("daemonStatus can report stale metadata without reaping it", async () => {
  const daemonDir = await scratchDaemonDir();
  const metadataFile = await writeMetadataFile(daemonDir);

  const status = await daemonStatus({ daemonDir, reap: false });

  expect(status.stale).toBe(true);
  expect(status.reaped).toBe(false);
  expect(await Bun.file(metadataFile).exists()).toBe(true);
});

// Metadata is written before the spawned child has finished establishing its own
// process group, so a live pid that does not yet match may still be a daemon
// mid-startup. Reaping it would delete the only record of how to stop it.
test("reaping leaves a live but not-yet-identifiable process alone during startup", async () => {
  const daemonDir = await scratchDaemonDir();
  const child = Bun.spawn(["sh", "-lc", "sleep 30"], { stdout: "ignore", stderr: "ignore" });
  spawned.push(child);
  const metadataFile = await writeMetadataFile(daemonDir, {
    pid: child.pid,
    pgid: child.pid,
    startedAt: new Date().toISOString(),
  });

  const result = await reapStaleDaemonMetadata({ daemonDir });

  expect(result.reaped).toBe(false);
  expect(result.reason).toBe("within start grace period");
  expect(await Bun.file(metadataFile).exists()).toBe(true);
});

// A pid that does not exist cannot be a daemon that is still starting, so a
// daemon killed seconds after start is reaped without waiting out the window.
test("reaping does not wait out the grace window for a pid that is already gone", async () => {
  const daemonDir = await scratchDaemonDir();
  const metadataFile = await writeMetadataFile(daemonDir, { startedAt: new Date().toISOString() });

  const result = await reapStaleDaemonMetadata({ daemonDir });

  expect(result.reaped).toBe(true);
  expect(await Bun.file(metadataFile).exists()).toBe(false);
});

// ─── Defect: pid liveness alone is not proof of identity ─────────────────────

// A recycled pid whose process group does not match the recorded daemon must be
// treated as stale and reaped, never signalled.
test("metadata whose recorded pgid is not its own process group is never signalled", async () => {
  const daemonDir = await scratchDaemonDir();
  const child = Bun.spawn(["sh", "-lc", "sleep 30"], { stdout: "ignore", stderr: "ignore" });
  spawned.push(child);
  const pid = child.pid;
  if (!pid) throw new Error("test child did not start");

  // A daemon started by bridge is always its own process group leader. Metadata
  // claiming otherwise must not be trusted to pick a process group to kill.
  await writeMetadataFile(daemonDir, {
    pid,
    pgid: process.pid,
    command: ["bridge", "serve", "--config", "/tmp/config.json", "--state", "/tmp/state.json", "--interval", "1000"],
  });

  const stopped = await stopProcessDaemon({ daemonDir });

  expect(stopped.running).toBe(false);
  expect(stopped.stale).toBe(false);
  expect(() => process.kill(pid, 0)).not.toThrow();
  expect(() => process.kill(process.pid, 0)).not.toThrow();
});

test("metadata with a non-signalable pid is reaped rather than acted on", async () => {
  const daemonDir = await scratchDaemonDir();
  const metadataFile = await writeMetadataFile(daemonDir, { pid: 0, pgid: 0 });

  const status = await daemonStatus({ daemonDir });

  expect(status.running).toBe(false);
  expect(await Bun.file(metadataFile).exists()).toBe(false);
});

// ─── Defect: a lock left behind by a crashed process wedges the daemon ───────

test("a lock directory abandoned by a dead process is broken instead of wedging", async () => {
  const daemonDir = await scratchDaemonDir();
  const paths = daemonPaths(daemonDir);
  const dead = Bun.spawn(["sh", "-lc", "exit 0"], { stdout: "ignore", stderr: "ignore" });
  await dead.exited;
  const deadPid = dead.pid;

  await mkdir(paths.lockDir, { mode: 0o700 });
  await writeFile(join(paths.lockDir, "owner.json"), JSON.stringify({ pid: deadPid, acquiredAt: new Date().toISOString() }), { mode: 0o600 });

  // Before the fix this threw "Another bridge daemon operation is already running"
  // and there was no way to recover short of deleting the directory by hand.
  const stopped = await stopProcessDaemon({ daemonDir });
  expect(stopped.running).toBe(false);
  expect(await Bun.file(join(paths.lockDir, "owner.json")).exists()).toBe(false);
});

test("an ownerless lock directory older than the max lock age is broken", async () => {
  const daemonDir = await scratchDaemonDir();
  const paths = daemonPaths(daemonDir);
  await mkdir(paths.lockDir, { mode: 0o700 });
  const old = new Date(Date.now() - 30 * 60_000);
  await utimes(paths.lockDir, old, old);

  const stopped = await stopProcessDaemon({ daemonDir });
  expect(stopped.running).toBe(false);
});

test("a lock held by a live process is still respected", async () => {
  const daemonDir = await scratchDaemonDir();
  const paths = daemonPaths(daemonDir);
  const holder = Bun.spawn(["sh", "-lc", "sleep 30"], { stdout: "ignore", stderr: "ignore" });
  spawned.push(holder);
  await mkdir(paths.lockDir, { mode: 0o700 });
  await writeFile(join(paths.lockDir, "owner.json"), JSON.stringify({ pid: holder.pid, acquiredAt: new Date().toISOString() }), { mode: 0o600 });

  await expect(stopProcessDaemon({ daemonDir })).rejects.toThrow("already running");
  expect(await Bun.file(join(paths.lockDir, "owner.json")).exists()).toBe(true);
});

// The lock directory now holds an owner file, so releasing it with rmdir(2)
// would silently fail (ENOTEMPTY) and leave the daemon wedged after one call.
test("the lock is fully released after a successful operation", async () => {
  const daemonDir = await scratchDaemonDir();
  const paths = daemonPaths(daemonDir);

  await stopProcessDaemon({ daemonDir });
  await expect(stat(paths.lockDir)).rejects.toThrow();

  await stopProcessDaemon({ daemonDir });
  await expect(stat(paths.lockDir)).rejects.toThrow();
});

// ─── Defect: `bridge daemon logs --lines N` returns N-1 lines ────────────────

// Log files end with a trailing newline, so splitting on newlines yields a final
// empty element. Slicing the last N elements therefore spent one of the caller's
// requested lines on that empty string.
test("tailFile returns the requested number of real log lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-logs-"));
  const logPath = join(dir, "bridge.out.log");
  await writeFile(logPath, "line-1\nline-2\nline-3\nline-4\nline-5\n");

  expect(await tailFile(logPath, 3)).toBe("line-3\nline-4\nline-5");
  expect(await tailFile(logPath, 99)).toBe("line-1\nline-2\nline-3\nline-4\nline-5");
  expect(await tailFile(join(dir, "missing.log"), 3)).toBe("");
});

test("tailFile preserves a partial trailing line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-logs-"));
  const logPath = join(dir, "bridge.err.log");
  await writeFile(logPath, "line-1\nline-2\npartial");

  expect(await tailFile(logPath, 2)).toBe("line-2\npartial");
});
