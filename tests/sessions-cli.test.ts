import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveConfig, type BridgeConfig } from "../src/index.js";

const config: BridgeConfig = {
  version: 1,
  channels: {
    local: { id: "local", kind: "console", enabled: true },
  },
  profiles: {},
  agents: {
    echo: { id: "echo", kind: "shell", command: "printf", args: ["reply:{prompt}"] },
  },
  routes: [],
};

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", "src/cli/index.ts", ...args], {
    cwd: process.cwd(),
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

test("session CLI creates, attaches, lists, and routes a message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-session-cli-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  await saveConfig(config, configPath);

  const created = await runCli([
    "sessions",
    "create",
    "--id",
    "ses_cli",
    "--agent",
    "echo",
    "--config",
    configPath,
    "--state",
    statePath,
    "--json",
  ]);
  expect(created.exitCode).toBe(0);
  expect(JSON.parse(created.stdout).id).toBe("ses_cli");

  const attached = await runCli([
    "sessions",
    "attach",
    "ses_cli",
    "--channel",
    "local",
    "--conversation",
    "thread",
    "--config",
    configPath,
    "--state",
    statePath,
    "--json",
  ]);
  expect(attached.exitCode).toBe(0);
  expect(JSON.parse(attached.stdout).conversationId).toBe("console:local:thread");

  const listed = await runCli(["sessions", "list", "--state", statePath, "--json"]);
  expect(JSON.parse(listed.stdout).map((session: { id: string }) => session.id)).toEqual(["ses_cli"]);

  const routed = await runCli([
    "sessions",
    "route-message",
    "--channel",
    "local",
    "--chat-id",
    "thread",
    "--text",
    "hello",
    "--config",
    configPath,
    "--state",
    statePath,
    "--json",
  ]);
  expect(routed.exitCode).toBe(0);
  const result = JSON.parse(routed.stdout);
  expect(result.session.status).toBe("delivered");
  expect(result.session.agent.stdout).toBe("reply:hello");
  expect(result.ledger.status).toBe("delivered");
});
