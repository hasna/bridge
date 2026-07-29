import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  missingTelegramTokenEnvVars,
  saveConfig,
  type BridgeConfig,
} from "../src/index.js";

function config(): BridgeConfig {
  return {
    version: 1,
    channels: {
      alpha: { id: "alpha", kind: "telegram", enabled: true, botTokenEnv: "ALPHA_TG_TOKEN", allowedChatIds: ["1"] },
      beta: { id: "beta", kind: "telegram", enabled: true, botTokenEnv: "BETA_TG_TOKEN", allowedChatIds: ["2"] },
      off: { id: "off", kind: "telegram", enabled: false, botTokenEnv: "OFF_TG_TOKEN", allowedChatIds: ["3"] },
      local: { id: "local", kind: "console", enabled: true },
    },
    profiles: {},
    agents: {},
    routes: [],
  };
}

function spawnCli(args: string[], env: Record<string, string>) {
  return Bun.spawn(["bun", "run", "src/cli/index.ts", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
}

async function collect(proc: ReturnType<typeof spawnCli>) {
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("missingTelegramTokenEnvVars reports every enabled channel without a token", () => {
  delete process.env["ALPHA_TG_TOKEN"];
  delete process.env["BETA_TG_TOKEN"];
  delete process.env["OFF_TG_TOKEN"];

  const missing = missingTelegramTokenEnvVars(config());
  expect(missing.map((item) => item.channelId).sort()).toEqual(["alpha", "beta"]);
  expect(missing.map((item) => item.envVar).sort()).toEqual(["ALPHA_TG_TOKEN", "BETA_TG_TOKEN"]);

  process.env["ALPHA_TG_TOKEN"] = "token-a";
  try {
    expect(missingTelegramTokenEnvVars(config()).map((item) => item.envVar)).toEqual(["BETA_TG_TOKEN"]);
  } finally {
    delete process.env["ALPHA_TG_TOKEN"];
  }
});

test("serve fails fast (instead of looping forever) when a bot token is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-serve-preflight-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  await saveConfig(config(), configPath);

  // No --once: this is the long-running mode that previously spun forever
  // logging the same unrecoverable error, so the daemon never surfaced it.
  const proc = spawnCli(
    ["serve", "--interval", "50", "--config", configPath, "--state", statePath],
    { ALPHA_TG_TOKEN: "", BETA_TG_TOKEN: "" },
  );
  const timer = setTimeout(() => proc.kill("SIGKILL"), 15_000);
  const result = await collect(proc);
  clearTimeout(timer);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("ALPHA_TG_TOKEN");
  expect(result.stderr).toContain("BETA_TG_TOKEN");
  // The disabled channel is not a blocker.
  expect(result.stderr).not.toContain("OFF_TG_TOKEN");
  // No retry spam: the failure is reported once, not once per backoff cycle.
  expect(result.stderr.split("ALPHA_TG_TOKEN").length - 1).toBe(1);
});

test("serve stops promptly on SIGTERM even while blocked in a long poll", async () => {
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/getUpdates")) {
        await held;
        return Response.json({ ok: true, result: [] });
      }
      return Response.json({ ok: false }, { status: 404 });
    },
  });

  const dir = await mkdtemp(join(tmpdir(), "bridge-serve-sigterm-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  await saveConfig(config(), configPath);

  const proc = spawnCli(
    ["serve", "--interval", "50", "--config", configPath, "--state", statePath],
    {
      ALPHA_TG_TOKEN: "token-a",
      BETA_TG_TOKEN: "token-b",
      BRIDGE_TELEGRAM_API_BASE: `http://127.0.0.1:${server.port}`,
    },
  );

  try {
    await Bun.sleep(1500);
    const started = Date.now();
    proc.kill("SIGTERM");
    const killTimer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
    const result = await collect(proc);
    clearTimeout(killTimer);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(5000);
    expect(result.exitCode).toBe(0);
  } finally {
    release?.();
    server.stop(true);
  }
}, 30_000);

test("a second signal force-exits serve while an agent run is still in flight", async () => {
  // The first signal cannot interrupt an in-flight agent run (a codewith turn can
  // take minutes), so a repeated Ctrl-C / SIGTERM must remain an escape hatch.
  const update = {
    update_id: 500,
    message: { message_id: 1, text: "hang", chat: { id: 1, type: "private" }, date: 0 },
  };
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname.endsWith("/getUpdates")) {
        return Response.json({ ok: true, result: [update] });
      }
      return Response.json({ ok: true, result: {} });
    },
  });

  const dir = await mkdtemp(join(tmpdir(), "bridge-serve-force-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const hanging: BridgeConfig = {
    version: 1,
    channels: {
      alpha: {
        id: "alpha", kind: "telegram", enabled: true, botTokenEnv: "ALPHA_TG_TOKEN",
        allowedChatIds: ["1"], defaultAgentId: "sleeper",
      },
    },
    profiles: {},
    // Explicit cwd keeps the run hermetic (no real workspace provisioning).
    agents: { sleeper: { id: "sleeper", kind: "shell", command: "sh", args: ["-c", "sleep 120", "{prompt}"], cwd: tmpdir() } },
    routes: [],
  };
  await saveConfig(hanging, configPath);

  const proc = spawnCli(
    ["serve", "--interval", "50", "--config", configPath, "--state", statePath],
    { ALPHA_TG_TOKEN: "token-a", BRIDGE_TELEGRAM_API_BASE: `http://127.0.0.1:${server.port}` },
  );

  try {
    // Give the poll loop time to pick up the update and start the sleeping agent.
    await Bun.sleep(2500);
    proc.kill("SIGTERM");
    await Bun.sleep(500);
    const started = Date.now();
    proc.kill("SIGTERM");
    const killTimer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
    const result = await collect(proc);
    clearTimeout(killTimer);

    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("forced shutdown");
  } finally {
    server.stop(true);
  }
}, 30_000);
