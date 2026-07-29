import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig, type BridgeConfig } from "../src/index.js";

function config(): BridgeConfig {
  return {
    version: 1,
    channels: {
      local: { id: "local", kind: "console", enabled: true },
      tg: {
        id: "tg",
        kind: "telegram",
        enabled: true,
        botTokenEnv: "CLI_ERRORS_TG_TOKEN",
        allowedChatIds: ["1"],
      },
    },
    profiles: {},
    agents: {
      echo: { id: "echo", kind: "shell", command: "printf", args: ["reply:{prompt}"], cwd: tmpdir() },
    },
    routes: [],
  };
}

async function runCli(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", "run", "src/cli/index.ts", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLI_ERRORS_TG_TOKEN: "", ...env },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function withConfig(): Promise<{ configPath: string; statePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "bridge-cli-errors-"));
  const configPath = join(dir, "config.json");
  await saveConfig(config(), configPath);
  return { configPath, statePath: join(dir, "state.json") };
}

test("doctor --json exits non-zero when a check fails", async () => {
  const { configPath } = await withConfig();

  const plain = await runCli(["doctor", "--config", configPath]);
  const json = await runCli(["doctor", "--config", configPath, "--json"]);

  const report = JSON.parse(json.stdout);
  expect(report.ok).toBe(false);
  expect(plain.exitCode).toBe(1);
  // Same report, same exit code — scripts must not silently pass with --json.
  expect(json.exitCode).toBe(1);
});

test("doctor exits zero when every check passes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-cli-doctor-ok-"));
  const configPath = join(dir, "config.json");
  await saveConfig({ version: 1, channels: {}, profiles: {}, agents: {}, routes: [] }, configPath);
  const result = await runCli(["doctor", "--config", configPath, "--json"]);
  const report = JSON.parse(result.stdout);
  // The ambient machine may have unrelated failures (e.g. a stale daemon pid);
  // only assert the exit code tracks the report.
  expect(result.exitCode).toBe(report.ok ? 0 : 1);
});

test("a user-facing error prints one clean line, not a source dump", async () => {
  const { configPath } = await withConfig();
  const result = await runCli(["send", "nope", "hi", "--config", configPath]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Channel not found: nope");
  expect(result.stderr).not.toContain("at <anonymous>");
  expect(result.stderr).not.toContain("src/cli/index.ts:");
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
});

test("a Telegram network failure never prints the bot token to the terminal", async () => {
  const { configPath } = await withConfig();
  const token = "999888:CLI-SECRET-TOKEN-VALUE";
  const result = await runCli(
    ["send", "tg", "1", "hello", "--config", configPath],
    { CLI_ERRORS_TG_TOKEN: token, BRIDGE_TELEGRAM_API_BASE: "http://127.0.0.1:1" },
  );

  expect(result.exitCode).toBe(1);
  expect(`${result.stdout}${result.stderr}`).not.toContain(token);
  expect(`${result.stdout}${result.stderr}`).not.toContain("CLI-SECRET");
});

test("broadcast accepts multi-word text like send and ask do", async () => {
  const { configPath, statePath } = await withConfig();
  const result = await runCli([
    "broadcast", "local", "hello", "brave", "world",
    "--config", configPath, "--state", statePath,
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("hello brave world");

  const reports = await runCli(["broadcasts", "list", "--state", statePath, "--json"]);
  expect(JSON.parse(reports.stdout)[0].text).toBe("hello brave world");
});

test("sessions send exits non-zero when the message was not delivered", async () => {
  const { configPath, statePath } = await withConfig();

  const created = await runCli([
    "sessions", "create", "--id", "ses_paused", "--agent", "echo",
    "--config", configPath, "--state", statePath,
  ]);
  expect(created.exitCode).toBe(0);

  const paused = await runCli(["sessions", "pause", "ses_paused", "--state", statePath]);
  expect(paused.exitCode).toBe(0);

  const sent = await runCli([
    "sessions", "send", "ses_paused", "hello",
    "--config", configPath, "--state", statePath,
  ]);
  expect(sent.exitCode).not.toBe(0);
});

test("sessions send still exits zero on a successful delivery", async () => {
  const { configPath, statePath } = await withConfig();
  await runCli([
    "sessions", "create", "--id", "ses_ok", "--agent", "echo",
    "--config", configPath, "--state", statePath,
  ]);
  const sent = await runCli([
    "sessions", "send", "ses_ok", "hello",
    "--config", configPath, "--state", statePath,
  ]);
  expect(sent.exitCode).toBe(0);
  expect(sent.stdout).toContain("reply:hello");
});

test("send refuses an empty message instead of calling the Telegram API", async () => {
  const { configPath } = await withConfig();
  const result = await runCli(
    ["send", "tg", "1", "--config", configPath],
    { CLI_ERRORS_TG_TOKEN: "token", BRIDGE_TELEGRAM_API_BASE: "http://127.0.0.1:1" },
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("message text is required");
  // Nothing was attempted over the network.
  expect(result.stderr).not.toContain("Unable to connect");
});
