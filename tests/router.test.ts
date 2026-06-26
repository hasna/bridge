import { expect, test } from "bun:test";
import { matchingRoutes, routeMessage, type AgentRunResult, type BridgeConfig } from "../src/index.js";

const config: BridgeConfig = {
  version: 1,
  channels: {
    local: { id: "local", kind: "console", enabled: true },
    tg: { id: "tg", kind: "telegram", botTokenEnv: "TG_TOKEN", enabled: true, allowedChatIds: ["1"] },
  },
  profiles: {},
  agents: {
    echo: { id: "echo", kind: "shell", command: "printf", args: ["ok"] },
  },
  routes: [
    { id: "enabled", fromChannel: "tg", toAgent: "echo", enabled: true, match: { chatIds: ["1"], textRegex: "^hi" } },
    { id: "disabled", fromChannel: "tg", toAgent: "echo", enabled: false },
  ],
};

test("matches enabled routes by channel chat and regex", () => {
  const routes = matchingRoutes(config, {
    id: "m",
    channelId: "tg",
    chatId: "1",
    text: "hi bridge",
    receivedAt: new Date(0).toISOString(),
  });
  expect(routes.map((route) => route.id)).toEqual(["enabled"]);
});

test("rejects messages outside a Telegram channel allowlist", () => {
  const routes = matchingRoutes(config, {
    id: "m",
    channelId: "tg",
    chatId: "2",
    text: "hi bridge",
    receivedAt: new Date(0).toISOString(),
  });
  expect(routes).toEqual([]);
});

test("rejects messages from disabled channels", () => {
  const disabledConfig: BridgeConfig = {
    ...config,
    channels: {
      ...config.channels,
      tg: { id: "tg", kind: "telegram", botTokenEnv: "TG_TOKEN", enabled: false, allowedChatIds: ["1"] },
    },
  };
  const routes = matchingRoutes(disabledConfig, {
    id: "m",
    channelId: "tg",
    chatId: "1",
    text: "hi bridge",
    receivedAt: new Date(0).toISOString(),
  });
  expect(routes).toEqual([]);
});

test("rejects Telegram channels without allowlist or explicit allow-all", () => {
  const openConfig: BridgeConfig = {
    ...config,
    channels: {
      tg: { id: "tg", kind: "telegram", botTokenEnv: "TG_TOKEN", enabled: true },
    },
  };
  const routes = matchingRoutes(openConfig, {
    id: "m",
    channelId: "tg",
    chatId: "1",
    text: "hi bridge",
    receivedAt: new Date(0).toISOString(),
  });
  expect(routes).toEqual([]);
});

test("allows all Telegram chats only when explicitly configured", () => {
  const openConfig: BridgeConfig = {
    ...config,
    channels: {
      tg: { id: "tg", kind: "telegram", botTokenEnv: "TG_TOKEN", enabled: true, allowAllChats: true },
    },
    routes: [
      { id: "enabled", fromChannel: "tg", toAgent: "echo", enabled: true, match: { textRegex: "^hi" } },
    ],
  };
  const routes = matchingRoutes(openConfig, {
    id: "m",
    channelId: "tg",
    chatId: "999",
    text: "hi bridge",
    receivedAt: new Date(0).toISOString(),
  });
  expect(routes.map((route) => route.id)).toEqual(["enabled"]);
});

test("routes messages through injectable runner", async () => {
  process.env[["TG", "TOKEN"].join("_")] = "test-token";
  let sent = 0;
  const results = await routeMessage(config, {
    id: "m",
    channelId: "tg",
    chatId: "1",
    text: "hi bridge",
    receivedAt: new Date(0).toISOString(),
  }, {
    run: async (_config, agentId): Promise<AgentRunResult> => ({
      agentId,
      command: ["fake"],
      exitCode: 0,
      stdout: "done",
      stderr: "",
      timedOut: false,
    }),
    sendTelegram: async () => {
      sent++;
      return { ok: true };
    },
  });

  expect(results).toHaveLength(1);
  expect(results[0]?.agent.stdout).toBe("done");
  expect(results[0]?.deliveredResponse).toBe(true);
  expect(sent).toBe(1);
});

test("does not send Telegram responses outside response channel allowlist", async () => {
  process.env[["TG", "TOKEN"].join("_")] = "test-token";
  let sent = 0;
  const results = await routeMessage(config, {
    id: "m",
    channelId: "tg",
    chatId: "2",
    text: "hi bridge",
    receivedAt: new Date(0).toISOString(),
  }, {
    run: async (_config, agentId): Promise<AgentRunResult> => ({
      agentId,
      command: ["fake"],
      exitCode: 0,
      stdout: "done",
      stderr: "",
      timedOut: false,
    }),
    sendTelegram: async () => {
      sent++;
      return { ok: true };
    },
  });

  expect(results).toEqual([]);
  expect(sent).toBe(0);
});

test("does not send Telegram responseChannel messages outside response allowlist", async () => {
  process.env[["TG", "TOKEN"].join("_")] = "test-token";
  let sent = 0;
  const responseConfig: BridgeConfig = {
    ...config,
    channels: {
      local: { id: "local", kind: "console", enabled: true },
      tg: { id: "tg", kind: "telegram", botTokenEnv: "TG_TOKEN", enabled: true, allowedChatIds: ["1"] },
    },
    routes: [
      { id: "local-telegram", fromChannel: "local", toAgent: "echo", responseChannel: "tg", enabled: true },
    ],
  };
  const results = await routeMessage(responseConfig, {
    id: "m",
    channelId: "local",
    chatId: "2",
    text: "hi bridge",
    receivedAt: new Date(0).toISOString(),
  }, {
    run: async (_config, agentId): Promise<AgentRunResult> => ({
      agentId,
      command: ["fake"],
      exitCode: 0,
      stdout: "done",
      stderr: "",
      timedOut: false,
    }),
    sendTelegram: async () => {
      sent++;
      return { ok: true };
    },
  });

  expect(results).toHaveLength(1);
  expect(results[0]?.deliveredResponse).toBe(false);
  expect(sent).toBe(0);
});

test("does not deliver responses through disabled channels", async () => {
  let sent = 0;
  const disabledResponseConfig: BridgeConfig = {
    ...config,
    channels: {
      local: { id: "local", kind: "console", enabled: true },
      tg: { id: "tg", kind: "telegram", botTokenEnv: "TG_TOKEN", enabled: false, allowedChatIds: ["1"] },
    },
    routes: [
      { id: "local-telegram", fromChannel: "local", toAgent: "echo", responseChannel: "tg", enabled: true },
    ],
  };
  const results = await routeMessage(disabledResponseConfig, {
    id: "m",
    channelId: "local",
    chatId: "1",
    text: "hi bridge",
    receivedAt: new Date(0).toISOString(),
  }, {
    run: async (_config, agentId): Promise<AgentRunResult> => ({
      agentId,
      command: ["fake"],
      exitCode: 0,
      stdout: "done",
      stderr: "",
      timedOut: false,
    }),
    sendTelegram: async () => {
      sent++;
      return { ok: true };
    },
  });

  expect(results).toHaveLength(1);
  expect(results[0]?.deliveredResponse).toBe(false);
  expect(sent).toBe(0);
});
