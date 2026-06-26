import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  daemonLogs,
  daemonPaths,
  daemonStatus,
  installDaemon,
  doctor,
  renderLaunchdPlist,
  renderSystemdUnit,
  saveConfig,
  stopProcessDaemon,
  telegramApiBaseInfo,
  type BridgeConfig,
} from "../src/index.js";

const daemonDirs: string[] = [];

afterEach(async () => {
  for (const dir of daemonDirs.splice(0)) {
    await stopProcessDaemon({ daemonDir: dir, timeoutMs: 2000, force: true }).catch(() => undefined);
  }
  delete process.env["BRIDGE_TELEGRAM_API_BASE"];
  delete process.env["TG_TEST_TOKEN"];
});

function testConfig(): BridgeConfig {
  return {
    version: 1,
    channels: {
      tg: {
        id: "tg",
        kind: "telegram",
        enabled: true,
        botTokenEnv: "TG_TEST_TOKEN",
        allowedChatIds: ["1"],
        pollTimeoutSeconds: 1,
      },
    },
    profiles: {},
    agents: {},
    routes: [],
  };
}

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

test("renders supervisor files without token values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-daemon-"));
  const paths = daemonPaths(dir);
  const command = ["/opt/homebrew/bin/bun", "/bridge dir/dist/cli/index.js", "serve", "--config", "/tmp/config %n.json"];

  const launchd = renderLaunchdPlist(command, paths);
  const systemd = renderSystemdUnit(command, paths);

  expect(launchd).toContain("com.hasna.bridge");
  expect(systemd).toContain("Restart=always");
  expect(systemd).toContain("\"/tmp/config %%n.json\"");
  expect(launchd).not.toContain("secret-token");
  expect(systemd).not.toContain("secret-token");
});

test("installs supervisor files privately and reports required env names only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-daemon-"));
  const configPath = join(dir, "config.json");
  await saveConfig(testConfig(), configPath);
  process.env["TG_TEST_TOKEN"] = "secret-token";
  const originalHome = process.env["HOME"];
  process.env["HOME"] = dir;

  try {
    const result = await installDaemon({
      supervisor: "launchd",
      daemonDir: join(dir, "daemon"),
      configPath,
      statePath: join(dir, "state.json"),
    });
    const body = await readFile(result.path, "utf-8");

    expect(result.requiredEnv).toEqual(["TG_TEST_TOKEN"]);
    expect(body).toContain("serve");
    expect(body).not.toContain("secret-token");
    expect((await stat(result.path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "daemon", "bridge.out.log"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "daemon", "bridge.err.log"))).mode & 0o777).toBe(0o600);
    expect(result.path.startsWith(dir)).toBe(true);
  } finally {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
  }
});

test("reports Telegram API base override without credentials", () => {
  process.env["BRIDGE_TELEGRAM_API_BASE"] = "http://127.0.0.1:9999/test/";
  expect(telegramApiBaseInfo()).toEqual({
    overridden: true,
    origin: "http://127.0.0.1:9999",
    pathname: "/test/",
  });

  process.env["BRIDGE_TELEGRAM_API_BASE"] = "https://user:pass@example.com";
  expect(() => telegramApiBaseInfo()).toThrow("must not contain credentials");

  process.env["BRIDGE_TELEGRAM_API_BASE"] = "https://example.com/?x=1";
  expect(() => telegramApiBaseInfo()).toThrow("must not contain query strings or fragments");

  process.env["BRIDGE_TELEGRAM_API_BASE"] = "https://example.com/#token";
  expect(() => telegramApiBaseInfo()).toThrow("must not contain query strings or fragments");
});

test("doctor reports invalid Telegram API base override", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-daemon-"));
  const configPath = join(dir, "config.json");
  await saveConfig(testConfig(), configPath);
  process.env["BRIDGE_TELEGRAM_API_BASE"] = "file:///tmp/telegram";

  const report = await doctor(configPath, join(dir, "state.json"));
  const check = report.checks.find((item) => item.name === "telegram-api-base");
  expect(check?.ok).toBe(false);
  expect(check?.detail).toContain("must use http or https");
});

test("process daemon starts, polls fake Telegram, reports status, logs, and stops", async () => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/getUpdates")) {
        requests++;
        return Response.json({ ok: true, result: [] });
      }
      return Response.json({ ok: false }, { status: 404 });
    },
  });

  const dir = await mkdtemp(join(tmpdir(), "bridge-daemon-"));
  const daemonDir = join(dir, "daemon");
  daemonDirs.push(daemonDir);
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  await saveConfig(testConfig(), configPath);

  const env = {
    TG_TEST_TOKEN: "test-token",
    BRIDGE_TELEGRAM_API_BASE: `http://127.0.0.1:${server.port}`,
  };

  try {
    const start = await runCli([
      "daemon",
      "start",
      "--daemon-dir",
      daemonDir,
      "--config",
      configPath,
      "--state",
      statePath,
      "--interval",
      "50",
      "--json",
    ], env);
    expect(start.exitCode).toBe(0);
    const started = JSON.parse(start.stdout);
    expect(started.running).toBe(true);

    for (let i = 0; i < 20 && requests === 0; i++) await Bun.sleep(100);
    expect(requests).toBeGreaterThan(0);

    const status = await daemonStatus({ daemonDir });
    expect(status.running).toBe(true);
    expect(status.telegramApiBase.overridden).toBe(false);
    expect(status.metadata?.identity.configPath).toBe(configPath);
    expect((await stat(status.paths.dir)).mode & 0o777).toBe(0o700);
    expect((await stat(status.paths.metadataFile)).mode & 0o777).toBe(0o600);

    const logs = await daemonLogs({ daemonDir, lines: 20 });
    expect(logs.stdout).toBeString();
    expect(logs.stderr).toBeString();

    const stop = await runCli(["daemon", "stop", "--daemon-dir", daemonDir, "--json"], env);
    expect(stop.exitCode).toBe(0);
    const stopped = JSON.parse(stop.stdout);
    expect(stopped.running).toBe(false);
  } finally {
    server.stop(true);
  }
});

test("daemon CLI rejects partial numeric values", async () => {
  const result = await runCli(["daemon", "logs", "--lines", "10abc"]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("--lines must be a non-negative integer");
});

test("stale daemon metadata is reported and cleaned on stop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-daemon-"));
  const paths = daemonPaths(dir);
  await writeFile(paths.metadataFile, JSON.stringify({
    version: 1,
    supervisor: "process",
    pid: 999999,
    startedAt: new Date().toISOString(),
    command: ["bridge", "serve"],
    cwd: process.cwd(),
    configPath: "/tmp/config.json",
    statePath: "/tmp/state.json",
    intervalMs: 1000,
    serveJson: false,
    daemonDir: dir,
    bridgeHome: dir,
    stdoutLog: paths.stdoutLog,
    stderrLog: paths.stderrLog,
  }, null, 2));

  const status = await daemonStatus({ daemonDir: dir });
  expect(status.stale).toBe(true);

  const stopped = await stopProcessDaemon({ daemonDir: dir });
  expect(stopped.running).toBe(false);
  expect(stopped.stale).toBe(false);
});

test("stop does not signal unrelated live process from stale metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-daemon-"));
  const paths = daemonPaths(dir);
  const child = Bun.spawn(["sh", "-lc", "sleep 30"], {
    detached: true,
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();
  const pid = child.pid;
  if (!pid) throw new Error("test child did not start");

  try {
    await writeFile(paths.metadataFile, JSON.stringify({
      version: 1,
      supervisor: "process",
      pid,
      pgid: pid,
      startedAt: new Date().toISOString(),
      identity: {
        command: "'bridge' 'serve' '--config' '/tmp/config.json' '--state' '/tmp/state.json'",
        cwd: process.cwd(),
        configPath: "/tmp/config.json",
        statePath: "/tmp/state.json",
        daemonDir: dir,
        bridgeHome: dir,
      },
      command: ["bridge", "serve", "--config", "/tmp/config.json", "--state", "/tmp/state.json"],
      cwd: process.cwd(),
      configPath: "/tmp/config.json",
      statePath: "/tmp/state.json",
      intervalMs: 1000,
      serveJson: false,
      daemonDir: dir,
      bridgeHome: dir,
      stdoutLog: paths.stdoutLog,
      stderrLog: paths.stderrLog,
    }, null, 2));

    const stopped = await stopProcessDaemon({ daemonDir: dir });
    expect(stopped.running).toBe(false);
    expect(stopped.stale).toBe(false);
    expect(() => process.kill(pid, 0)).not.toThrow();
  } finally {
    child.kill("SIGKILL");
  }
});
