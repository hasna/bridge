import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { ensureConfig, loadConfig, saveState, upsertAgent, upsertChannel, upsertProfile, upsertRoute } from "../src/index.js";

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
