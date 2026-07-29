import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { doctor, saveConfig, type BridgeConfig } from "../src/index.js";

afterEach(() => {
  delete process.env["TG_TEST_TOKEN"];
  delete process.env["BRIDGE_TELEGRAM_API_BASE"];
});

function telegramConfig(): BridgeConfig {
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

async function scratch(): Promise<{ dir: string; configPath: string; statePath: string; daemonDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "bridge-doctor-"));
  return {
    dir,
    configPath: join(dir, "config.json"),
    statePath: join(dir, "state.json"),
    daemonDir: join(dir, "daemon"),
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

// Regression: `bridge doctor --json` reported failing checks but exited 0, so CI
// and shell scripts could not gate on bridge health.
test("doctor --json exits non-zero when an error-severity check fails", async () => {
  const { dir, configPath, statePath, daemonDir } = await scratch();
  await saveConfig(telegramConfig(), configPath);

  const result = await runCli(
    ["doctor", "-c", configPath, "--state", statePath, "--daemon-dir", daemonDir, "--json"],
    { BRIDGE_HOME: dir, TG_TEST_TOKEN: "" },
  );

  const report = JSON.parse(result.stdout);
  expect(report.ok).toBe(false);
  expect(result.exitCode).not.toBe(0);
});

test("doctor text output exits non-zero and marks the failing check", async () => {
  const { dir, configPath, statePath, daemonDir } = await scratch();
  await saveConfig(telegramConfig(), configPath);

  const result = await runCli(
    ["doctor", "-c", configPath, "--state", statePath, "--daemon-dir", daemonDir],
    { BRIDGE_HOME: dir, TG_TEST_TOKEN: "" },
  );

  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toContain("fail telegram-token:tg");
});

test("doctor exits zero when every error-severity check passes", async () => {
  const { dir, configPath, statePath, daemonDir } = await scratch();
  await saveConfig(telegramConfig(), configPath);
  await writeFile(statePath, "{}\n", { mode: 0o600 });
  await chmod(statePath, 0o600);

  const result = await runCli(
    ["doctor", "-c", configPath, "--state", statePath, "--daemon-dir", daemonDir, "--json"],
    { BRIDGE_HOME: dir, TG_TEST_TOKEN: "present" },
  );

  const report = JSON.parse(result.stdout);
  expect(report.ok).toBe(true);
  expect(result.exitCode).toBe(0);
});

// Regression: the CLI never forwarded a state path, so `bridge doctor` always
// inspected the default state file even when pointed at another config.
test("doctor inspects the state path it was given", async () => {
  const { dir, configPath, statePath, daemonDir } = await scratch();
  await saveConfig(telegramConfig(), configPath);
  await writeFile(statePath, "{}\n");
  await chmod(statePath, 0o644);

  const result = await runCli(
    ["doctor", "-c", configPath, "--state", statePath, "--daemon-dir", daemonDir, "--json"],
    { BRIDGE_HOME: dir, TG_TEST_TOKEN: "present" },
  );

  const report = JSON.parse(result.stdout);
  const stateCheck = report.checks.find((check: { name: string }) => check.name === "state");
  expect(stateCheck.detail).toContain(statePath);
  expect(stateCheck.ok).toBe(false);
  expect(result.exitCode).not.toBe(0);
});

// Regression: a missing optional agent runtime (`claude`, `codewith`, `aicopilot`)
// was a hard failure, so doctor exited non-zero on a perfectly healthy bridge that
// simply does not use those runtimes.
test("missing optional agent runtimes are warnings, not failures", async () => {
  const { configPath, statePath, daemonDir } = await scratch();
  await saveConfig(telegramConfig(), configPath);
  process.env["TG_TEST_TOKEN"] = "present";
  const emptyBin = await mkdtemp(join(tmpdir(), "bridge-emptybin-"));
  const originalPath = process.env["PATH"];
  process.env["PATH"] = emptyBin;

  try {
    const report = await doctor(configPath, statePath, { daemonDir });
    const claude = report.checks.find((check) => check.name === "command:claude");
    expect(claude?.ok).toBe(false);
    expect(claude?.severity).toBe("warn");
    expect(report.ok).toBe(true);
  } finally {
    process.env["PATH"] = originalPath;
  }
});

// Regression: the same runtime check must stay a hard failure when the config
// actually routes messages to that runtime.
test("a missing runtime a configured agent depends on is an error", async () => {
  const { configPath, statePath, daemonDir } = await scratch();
  const config = telegramConfig();
  config.agents = { c: { id: "c", kind: "claude" } };
  await saveConfig(config, configPath);
  process.env["TG_TEST_TOKEN"] = "present";
  const emptyBin = await mkdtemp(join(tmpdir(), "bridge-emptybin-"));
  const originalPath = process.env["PATH"];
  process.env["PATH"] = emptyBin;

  try {
    const report = await doctor(configPath, statePath, { daemonDir });
    const claude = report.checks.find((check) => check.name === "command:claude");
    expect(claude?.ok).toBe(false);
    expect(claude?.severity).toBe("error");
    expect(report.ok).toBe(false);
  } finally {
    process.env["PATH"] = originalPath;
  }
});

// An agent with an explicit command does not shell out to the runtime binary, so
// the missing binary must not be escalated to an error on its behalf.
test("an agent with an explicit command does not escalate the runtime check", async () => {
  const { configPath, statePath, daemonDir } = await scratch();
  const config = telegramConfig();
  config.agents = { c: { id: "c", kind: "claude", command: "printf", args: ["{prompt}"] } };
  await saveConfig(config, configPath);
  process.env["TG_TEST_TOKEN"] = "present";
  const emptyBin = await mkdtemp(join(tmpdir(), "bridge-emptybin-"));
  const originalPath = process.env["PATH"];
  process.env["PATH"] = emptyBin;

  try {
    const report = await doctor(configPath, statePath, { daemonDir });
    expect(report.checks.find((check) => check.name === "command:claude")?.severity).toBe("warn");
    expect(report.ok).toBe(true);
  } finally {
    process.env["PATH"] = originalPath;
  }
});

// A missing Telegram bot token means the bridge cannot receive anything, so it
// must stay a hard failure (the seed case: agents configured, zero tokens set).
test("a missing Telegram bot token is an error-severity failure", async () => {
  const { configPath, statePath, daemonDir } = await scratch();
  await saveConfig(telegramConfig(), configPath);
  delete process.env["TG_TEST_TOKEN"];

  const report = await doctor(configPath, statePath, { daemonDir });
  const token = report.checks.find((check) => check.name === "telegram-token:tg");
  expect(token?.ok).toBe(false);
  expect(token?.severity).toBe("error");
  expect(report.ok).toBe(false);
});

// Regression: doctor kept reporting `fail daemon-status - stale pid=N` forever
// because nothing reaped metadata left behind by a crashed daemon.
test("doctor reaps stale daemon metadata instead of reporting it forever", async () => {
  const { configPath, statePath, daemonDir } = await scratch();
  await saveConfig(telegramConfig(), configPath);
  process.env["TG_TEST_TOKEN"] = "present";
  await mkdir(daemonDir, { recursive: true, mode: 0o700 });
  const metadataFile = join(daemonDir, "bridge-daemon.json");
  await writeFile(metadataFile, JSON.stringify({
    version: 1,
    supervisor: "process",
    pid: 999999,
    pgid: 999999,
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    command: ["bridge", "serve"],
    cwd: process.cwd(),
    configPath,
    statePath,
    intervalMs: 1000,
    serveJson: false,
    daemonDir,
    bridgeHome: daemonDir,
    stdoutLog: join(daemonDir, "bridge.out.log"),
    stderrLog: join(daemonDir, "bridge.err.log"),
  }, null, 2), { mode: 0o600 });

  const first = await doctor(configPath, statePath, { daemonDir });
  expect(first.checks.find((check) => check.name === "daemon-status")?.ok).toBe(true);
  expect(await Bun.file(metadataFile).exists()).toBe(false);

  const second = await doctor(configPath, statePath, { daemonDir });
  expect(second.checks.find((check) => check.name === "daemon-status")?.detail).toBe("not running");
  expect(second.ok).toBe(true);
});
