import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  doctor,
  ensureConfig,
  loadConfig,
  redactConfig,
  saveState,
  upsertAgent,
  upsertChannel,
  upsertProfile,
  upsertRoute,
  type BridgeConfig,
} from "../src/index.js";

test("creates and loads an empty config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-config-"));
  const path = join(dir, "nested", "config.json");
  const config = await ensureConfig(path);

  expect(config.version).toBe(1);
  expect(config.channels).toEqual({});
  expect(JSON.parse(await readFile(path, "utf-8")).version).toBe(1);
  expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test("upserts channels profiles agents and routes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-config-"));
  const path = join(dir, "config.json");

  await upsertChannel({ id: "tg", kind: "telegram", botTokenEnv: "TG_TOKEN", enabled: true }, path);
  await upsertProfile({ id: "cw-main", agentKind: "codewith", authProfile: "account001" }, path);
  await upsertAgent({ id: "codewith", kind: "codewith", profileId: "cw-main" }, path);
  await upsertRoute({ id: "telegram-codewith", fromChannel: "tg", toAgent: "codewith", enabled: true }, path);

  const config = await loadConfig(path);
  expect(config.channels.tg?.kind).toBe("telegram");
  expect(config.profiles["cw-main"]?.authProfile).toBe("account001");
  expect(config.agents.codewith?.profileId).toBe("cw-main");
  expect(config.routes).toHaveLength(1);
});

test("writes state privately", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-state-"));
  const path = join(dir, "state.json");
  await saveState({ telegramOffsets: { tg: 10 } }, path);
  expect(JSON.parse(await readFile(path, "utf-8")).telegramOffsets.tg).toBe(10);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test("redacts profile and agent env values from shareable config views", () => {
  const config: BridgeConfig = {
    version: 1,
    channels: {},
    profiles: {
      prof: {
        id: "prof",
        agentKind: "shell",
        env: {
          API_KEY: "real-secret",
          MODE: "test",
        },
      },
    },
    agents: {
      agent: {
        id: "agent",
        kind: "shell",
        env: {
          TOKEN: "token-value",
        },
      },
    },
    routes: [],
  };

  const redacted = redactConfig(config);
  expect(redacted.profiles.prof?.env).toEqual({ API_KEY: "[redacted]", MODE: "[redacted]" });
  expect(redacted.agents.agent?.env).toEqual({ TOKEN: "[redacted]" });
  expect(config.profiles.prof?.env?.API_KEY).toBe("real-secret");
  expect(config.agents.agent?.env?.TOKEN).toBe("token-value");
});

test("doctor fails existing weak config permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-config-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  await ensureConfig(configPath);
  await chmod(configPath, 0o644);

  const report = await doctor(configPath, statePath);
  expect(report.ok).toBe(false);
  expect(report.checks.find((check) => check.name === "config")?.ok).toBe(false);
});

test("doctor fails existing weak state permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-state-"));
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  await ensureConfig(configPath);
  await saveState({ telegramOffsets: { tg: 1 } }, statePath);
  await chmod(statePath, 0o644);

  const report = await doctor(configPath, statePath);
  expect(report.ok).toBe(false);
  expect(report.checks.find((check) => check.name === "state")?.ok).toBe(false);
});

test("rejects a route textRegex that is not a valid regular expression", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-config-"));
  const path = join(dir, "config.json");
  await ensureConfig(path);

  // Previously accepted, then thrown as a raw SyntaxError from inside
  // matchingRoutes on every inbound message — which wedges the poll loop
  // because the offset can never advance past the failing message.
  const rejected = await upsertRoute(
    { id: "bad", fromChannel: "tg", toAgent: "echo", enabled: true, match: { textRegex: "[[" } },
    path,
  ).catch((err) => err);
  expect(rejected).toBeInstanceOf(Error);
  expect(String(rejected.message)).toContain("textRegex");

  const config = await loadConfig(path);
  expect(config.routes).toHaveLength(0);

  await upsertRoute(
    { id: "good", fromChannel: "tg", toAgent: "echo", enabled: true, match: { textRegex: "^hi\\b" } },
    path,
  );
  expect((await loadConfig(path)).routes).toHaveLength(1);
});

test("routes add surfaces an invalid regex as a clean CLI error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-config-"));
  const path = join(dir, "config.json");
  await ensureConfig(path);

  const proc = Bun.spawn([
    "bun", "run", "src/cli/index.ts",
    "routes", "add", "bad", "--from", "tg", "--to", "echo", "--text-regex", "[[", "--config", path,
  ], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

  expect(exitCode).toBe(1);
  expect(stderr).toContain("textRegex");
  expect(stderr).not.toContain("at <anonymous>");
  expect((await loadConfig(path)).routes).toHaveLength(0);
});

test("rejects a config whose record key does not match the entry id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-config-"));
  const path = join(dir, "config.json");

  // A hand-edited key/id mismatch used to load fine and then misbehave
  // silently: session bindings are keyed by channel.id while inbound lookups use
  // the record key, so `sessions attach` created a binding no message ever
  // matched and every message got the "no session attached" reply.
  await Bun.write(path, JSON.stringify({
    version: 1,
    channels: { "tg-old": { id: "tg", kind: "telegram", enabled: true, allowedChatIds: ["1"] } },
    profiles: {},
    agents: {},
    routes: [],
  }));

  const err = await loadConfig(path).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(String(err.message)).toContain("tg-old");

  await Bun.write(path, JSON.stringify({
    version: 1,
    channels: {},
    profiles: {},
    agents: { "a-old": { id: "a", kind: "shell" } },
    routes: [],
  }));
  const agentErr = await loadConfig(path).catch((e) => e);
  expect(agentErr).toBeInstanceOf(Error);
  expect(String(agentErr.message)).toContain("a-old");
});

test("a matching key and id still loads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-config-"));
  const path = join(dir, "config.json");
  await upsertChannel({ id: "tg", kind: "telegram", enabled: true, allowedChatIds: ["1"] }, path);
  await upsertAgent({ id: "a", kind: "shell" }, path);
  await upsertProfile({ id: "p", agentKind: "shell" }, path);
  const config = await loadConfig(path);
  expect(Object.keys(config.channels)).toEqual(["tg"]);
  expect(Object.keys(config.agents)).toEqual(["a"]);
  expect(Object.keys(config.profiles)).toEqual(["p"]);
});
