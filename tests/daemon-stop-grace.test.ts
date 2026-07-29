import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  daemonPaths,
  saveConfig,
  stopGraceMsForConfig,
  stopProcessDaemon,
  type BridgeConfig,
} from "../src/index.js";

const daemonDirs: string[] = [];
const spawned: Array<{ kill: (signal?: number | NodeJS.Signals) => void }> = [];

afterEach(async () => {
  for (const dir of daemonDirs.splice(0)) {
    await stopProcessDaemon({ daemonDir: dir, timeoutMs: 2000, force: true }).catch(() => undefined);
  }
  for (const child of spawned.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  delete process.env["TG_TEST_TOKEN"];
  delete process.env["BRIDGE_TELEGRAM_API_BASE"];
});

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", "src/cli/index.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

// ─── Derivation of the stop grace window ─────────────────────────────────────

// A hard-coded 5s stop budget cannot be right: serve only observes the stop flag
// between poll iterations, so it legitimately stays busy for as long as one
// in-flight agent turn plus one in-flight Telegram long poll.
test("the stop grace window is derived from the configured agent and poll budgets", () => {
  const config: BridgeConfig = {
    version: 1,
    channels: { tg: { id: "tg", kind: "telegram", enabled: true, botTokenEnv: "T", allowedChatIds: ["1"], pollTimeoutSeconds: 5 } },
    profiles: {},
    agents: { a: { id: "a", kind: "shell", timeoutMs: 30_000 } },
    routes: [],
  };

  // 30s agent turn + 5s long poll + settle margin.
  expect(stopGraceMsForConfig(config)).toBe(37_000);
});

test("unset agent and poll budgets fall back to the runtime defaults", () => {
  const config: BridgeConfig = {
    version: 1,
    channels: { tg: { id: "tg", kind: "telegram", enabled: true, botTokenEnv: "T", allowedChatIds: ["1"] } },
    profiles: {},
    agents: { a: { id: "a", kind: "codewith" } },
    routes: [],
  };

  // agents.ts defaults an agent turn to 120s; serve defaults the long poll to 20s.
  expect(stopGraceMsForConfig(config)).toBe(142_000);
});

test("the widest configured agent budget wins", () => {
  const config: BridgeConfig = {
    version: 1,
    channels: { tg: { id: "tg", kind: "telegram", enabled: true, botTokenEnv: "T", allowedChatIds: ["1"], pollTimeoutSeconds: 1 } },
    profiles: {},
    agents: {
      quick: { id: "quick", kind: "shell", timeoutMs: 1_000 },
      slow: { id: "slow", kind: "shell", timeoutMs: 90_000 },
    },
    routes: [],
  };

  expect(stopGraceMsForConfig(config)).toBe(93_000);
});

test("a bridge with nothing to wait for gets the floor, not a long ceiling", () => {
  const config: BridgeConfig = { version: 1, channels: {}, profiles: {}, agents: {}, routes: [] };
  expect(stopGraceMsForConfig(config)).toBe(5_000);
});

test("a disabled channel does not widen the window", () => {
  const config: BridgeConfig = {
    version: 1,
    channels: { tg: { id: "tg", kind: "telegram", enabled: false, botTokenEnv: "T", allowedChatIds: ["1"], pollTimeoutSeconds: 600 } },
    profiles: {},
    agents: {},
    routes: [],
  };
  expect(stopGraceMsForConfig(config)).toBe(5_000);
});

test("an absurd configured budget is capped so stop cannot hang forever", () => {
  const config: BridgeConfig = {
    version: 1,
    channels: {},
    profiles: {},
    agents: { a: { id: "a", kind: "shell", timeoutMs: 24 * 60 * 60_000 } },
    routes: [],
  };
  expect(stopGraceMsForConfig(config)).toBe(10 * 60_000);
});

// ─── Defect: stop killed a legitimately busy daemon's budget at 5s ───────────

// serve installs a SIGTERM handler (cli/index.ts:160) that only sets a stop
// flag, which suppresses the default terminate-on-signal. An agent run already
// in flight therefore runs to completion before serve exits. With a hard-coded
// 5s budget, `bridge daemon stop` threw "did not stop within 5000ms" on any
// bridge that was processing a message — and left the metadata behind.
test("stop waits out an in-flight agent run instead of failing at 5s", async () => {
  const update = {
    update_id: 900,
    message: { message_id: 1, text: "work", chat: { id: 1, type: "private" }, date: 0 },
  };
  let served = false;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/getUpdates")) {
        const offset = Number(url.searchParams.get("offset") || "0");
        const send = !served && offset <= 900;
        served = served || send;
        return Response.json({ ok: true, result: send ? [update] : [] });
      }
      if (url.pathname.endsWith("/sendMessage")) return Response.json({ ok: true, result: {} });
      return Response.json({ ok: false }, { status: 404 });
    },
  });

  const dir = await mkdtemp(join(tmpdir(), "bridge-stopgrace-"));
  const daemonDir = join(dir, "daemon");
  daemonDirs.push(daemonDir);
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const marker = join(dir, "agent-started");

  const config: BridgeConfig = {
    version: 1,
    channels: {
      tg: {
        id: "tg",
        kind: "telegram",
        enabled: true,
        botTokenEnv: "TG_TEST_TOKEN",
        allowedChatIds: ["1"],
        pollTimeoutSeconds: 1,
        defaultAgentId: "slow",
      },
    },
    profiles: {},
    agents: {
      // Ignores SIGTERM and outlives the old 5s budget: the same shape as an
      // agent spawned into its own process group, which the daemon's SIGTERM to
      // its own group no longer reaches.
      slow: {
        id: "slow",
        kind: "shell",
        command: "sh",
        args: ["-lc", `trap '' TERM; : > ${marker}; sleep 7; printf done`],
        cwd: tmpdir(),
        timeoutMs: 20_000,
      },
    },
    routes: [],
  };
  await saveConfig(config, configPath);

  const env = { TG_TEST_TOKEN: "test-token", BRIDGE_TELEGRAM_API_BASE: `http://127.0.0.1:${server.port}` };

  try {
    const start = await runCli(
      ["daemon", "start", "--daemon-dir", daemonDir, "--config", configPath, "--state", statePath, "--interval", "50", "--json"],
      env,
    );
    expect(start.exitCode).toBe(0);

    // Wait until the agent run is genuinely in flight.
    for (let i = 0; i < 100 && !(await Bun.file(marker).exists()); i++) await Bun.sleep(100);
    expect(await Bun.file(marker).exists()).toBe(true);

    // No explicit timeout: this is what plain `bridge daemon stop` does.
    const started = Date.now();
    const stopped = await stopProcessDaemon({ daemonDir });
    const elapsed = Date.now() - started;

    expect(stopped.running).toBe(false);
    expect(await Bun.file(daemonPaths(daemonDir).metadataFile).exists()).toBe(false);
    // It genuinely waited for the run rather than returning early.
    expect(elapsed).toBeGreaterThan(2_000);
  } finally {
    server.stop(true);
  }
}, 60_000);

// The wide ceiling must be an upper bound, never a delay an idle daemon sits out.
test("an idle daemon still stops in milliseconds despite a wide ceiling", async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true, result: [] }) });
  const dir = await mkdtemp(join(tmpdir(), "bridge-stopfast-"));
  const daemonDir = join(dir, "daemon");
  daemonDirs.push(daemonDir);
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");

  const config: BridgeConfig = {
    version: 1,
    channels: { tg: { id: "tg", kind: "telegram", enabled: true, botTokenEnv: "TG_TEST_TOKEN", allowedChatIds: ["1"], pollTimeoutSeconds: 1 } },
    profiles: {},
    // A 10 minute agent budget: the derived ceiling is huge, the stop must not be.
    agents: { slow: { id: "slow", kind: "shell", timeoutMs: 600_000 } },
    routes: [],
  };
  await saveConfig(config, configPath);
  const env = { TG_TEST_TOKEN: "test-token", BRIDGE_TELEGRAM_API_BASE: `http://127.0.0.1:${server.port}` };

  try {
    expect((await runCli(
      ["daemon", "start", "--daemon-dir", daemonDir, "--config", configPath, "--state", statePath, "--interval", "50", "--json"],
      env,
    )).exitCode).toBe(0);

    const started = Date.now();
    const stopped = await stopProcessDaemon({ daemonDir });
    const elapsed = Date.now() - started;

    expect(stopped.running).toBe(false);
    expect(elapsed).toBeLessThan(5_000);
  } finally {
    server.stop(true);
  }
}, 60_000);

// ─── Defect: exceeding the window threw and left the metadata behind ─────────

// Previously SIGKILL only happened when the caller passed `force`, so a process
// that ignores SIGTERM made `stop` throw with the metadata still on disk. Stop
// must always end in a defined state.
test("a daemon that ignores SIGTERM is escalated to SIGKILL and its metadata reaped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-stopkill-"));
  const daemonDir = join(dir, "daemon");
  await mkdir(daemonDir, { recursive: true, mode: 0o700 });
  const paths = daemonPaths(daemonDir);
  const configPath = "/tmp/stopkill-config.json";
  const statePath = "/tmp/stopkill-state.json";

  // A detached process that ignores SIGTERM, whose argv carries the tokens
  // processMatches() requires so the daemon accepts it as its own.
  const child = Bun.spawn([
    "sh", "-lc", "trap '' TERM; sleep 300",
    "bridge", "serve", "--config", configPath, "--state", statePath, "--interval", "1000",
  ], { detached: true, stdout: "ignore", stderr: "ignore" });
  child.unref();
  spawned.push(child);
  const pid = child.pid;
  if (!pid) throw new Error("test child did not start");

  await writeFile(paths.metadataFile, JSON.stringify({
    version: 1,
    supervisor: "process",
    pid,
    pgid: pid,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    identity: { command: "'bridge' 'serve'", cwd: process.cwd(), configPath, statePath, daemonDir, bridgeHome: daemonDir },
    command: ["bridge", "serve", "--config", configPath, "--state", statePath, "--interval", "1000"],
    cwd: process.cwd(),
    configPath,
    statePath,
    intervalMs: 1000,
    serveJson: false,
    daemonDir,
    bridgeHome: daemonDir,
    stdoutLog: paths.stdoutLog,
    stderrLog: paths.stderrLog,
  }, null, 2), { mode: 0o600 });

  // Short explicit window: the point is what happens when it is exceeded.
  const stopped = await stopProcessDaemon({ daemonDir, timeoutMs: 300 });

  expect(stopped.running).toBe(false);
  expect(await Bun.file(paths.metadataFile).exists()).toBe(false);
  expect(pidGone(pid)).toBe(true);
}, 30_000);

function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}
