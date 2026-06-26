import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  attachBridgeSession,
  createBridgeSession,
  dispatchMessageWithSessions,
  loadState,
  saveState,
  STATE_SCHEMA_VERSION,
  type AgentRunResult,
  type BridgeConfig,
} from "../src/index.js";

const config: BridgeConfig = {
  version: 1,
  channels: {
    local: { id: "local", kind: "console", enabled: true },
    tg: { id: "tg", kind: "telegram", enabled: true, botTokenEnv: "TG_TOKEN", allowedChatIds: ["1"] },
  },
  profiles: {},
  agents: {
    echo: { id: "echo", kind: "shell", command: "printf", args: ["ok:{prompt}"] },
  },
  routes: [],
};

test("loads and saves legacy state as schema version 2", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-state-"));
  const path = join(dir, "state.json");
  await saveState({ telegramOffsets: { tg: 10 } }, path);

  const body = JSON.parse(await readFile(path, "utf-8"));
  expect(body.schemaVersion).toBe(STATE_SCHEMA_VERSION);
  expect(body.telegramOffsets.tg).toBe(10);

  const state = await loadState(path);
  expect(state.schemaVersion).toBe(STATE_SCHEMA_VERSION);
  expect(state.sessions).toEqual({});
  expect(state.bindings).toEqual({});
  expect(state.messageLedger).toEqual({});
});

test("creates sessions and normalized bindings", async () => {
  const state = await loadState("/tmp/bridge-state-that-does-not-exist.json");
  const session = createBridgeSession(config, state, { id: "ses_test", agentId: "echo", title: "Echo" });
  const binding = attachBridgeSession(config, state, {
    sessionId: session.id,
    channelId: "tg",
    conversation: "1",
    makeDefault: true,
    authorization: { chatId: "1" },
  });

  expect(session.agentSession?.mode).toBe("compatibility");
  expect(binding.conversationId).toBe("telegram:tg:1");
  expect(binding.activeSessionId).toBe("ses_test");
  expect(state.bindings[binding.id]?.defaultSessionId).toBe("ses_test");
});

test("ledger prevents duplicate successful agent execution", async () => {
  const state = await loadState("/tmp/bridge-state-that-does-not-exist.json");
  const session = createBridgeSession(config, state, { id: "ses_test", agentId: "echo" });
  attachBridgeSession(config, state, { sessionId: session.id, channelId: "local", conversation: "thread" });
  let calls = 0;
  const run = async (_config: BridgeConfig, agentId: string): Promise<AgentRunResult> => {
    calls++;
    return {
      agentId,
      command: ["fake"],
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      timedOut: false,
    };
  };
  const message = {
    id: "msg-1",
    channelId: "local",
    chatId: "thread",
    text: "hello",
    receivedAt: new Date(0).toISOString(),
  };

  const first = await dispatchMessageWithSessions(config, state, message, { run, writeConsole: false });
  const second = await dispatchMessageWithSessions(config, state, message, { run, writeConsole: false });

  expect(first.ledger?.status).toBe("delivered");
  expect(second.ledger?.status).toBe("delivered");
  expect(calls).toBe(1);
});

test("processing ledger is persisted before invoking an agent", async () => {
  const state = await loadState("/tmp/bridge-state-that-does-not-exist.json");
  const session = createBridgeSession(config, state, { id: "ses_test", agentId: "echo" });
  attachBridgeSession(config, state, { sessionId: session.id, channelId: "local", conversation: "thread" });
  const snapshots: string[] = [];

  await dispatchMessageWithSessions(config, state, {
    id: "msg-persist",
    channelId: "local",
    chatId: "thread",
    text: "hello",
    receivedAt: new Date(0).toISOString(),
  }, {
    persistState: async (nextState) => {
      snapshots.push(nextState.messageLedger["local::msg-persist"]?.status || "missing");
    },
    run: async (_config, agentId): Promise<AgentRunResult> => ({
      agentId,
      command: ["fake"],
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      timedOut: false,
    }),
    writeConsole: false,
  });

  expect(snapshots).toEqual(["processing", "agent_completed"]);
});

test("agent failures remain retryable and do not become delivered", async () => {
  const state = await loadState("/tmp/bridge-state-that-does-not-exist.json");
  const session = createBridgeSession(config, state, { id: "ses_test", agentId: "echo" });
  attachBridgeSession(config, state, { sessionId: session.id, channelId: "local", conversation: "thread" });

  await expect(dispatchMessageWithSessions(config, state, {
    id: "msg-fail",
    channelId: "local",
    chatId: "thread",
    text: "hello",
    receivedAt: new Date(0).toISOString(),
  }, {
    run: async (_config, agentId): Promise<AgentRunResult> => ({
      agentId,
      command: ["fake"],
      exitCode: 2,
      stdout: "",
      stderr: "boom",
      timedOut: false,
    }),
    writeConsole: false,
  })).rejects.toThrow("boom");

  expect(state.messageLedger["local::msg-fail"]?.status).toBe("failed");
  expect(state.messageLedger["local::msg-fail"]?.terminalAt).toBeUndefined();
});

test("delivery retry does not rerun the agent after response is stored", async () => {
  const state = await loadState("/tmp/bridge-state-that-does-not-exist.json");
  const session = createBridgeSession(config, state, { id: "ses_test", agentId: "echo" });
  attachBridgeSession(config, state, { sessionId: session.id, channelId: "tg", conversation: "1" });
  process.env["TG_TOKEN"] = "test-token";
  let runs = 0;
  let sends = 0;
  const message = {
    id: "telegram:delivery",
    channelId: "tg",
    chatId: "1",
    text: "hello",
    receivedAt: new Date(0).toISOString(),
  };

  await expect(dispatchMessageWithSessions(config, state, message, {
    run: async (_config, agentId): Promise<AgentRunResult> => {
      runs++;
      return { agentId, command: ["fake"], exitCode: 0, stdout: "stored-response", stderr: "", timedOut: false };
    },
    sendTelegram: async () => {
      sends++;
      throw new Error("network down");
    },
  })).rejects.toThrow("network down");

  expect(state.messageLedger["tg::telegram:delivery"]?.status).toBe("agent_completed");
  expect(state.messageLedger["tg::telegram:delivery"]?.responseText).toBe("stored-response");

  const retry = await dispatchMessageWithSessions(config, state, message, {
    run: async (_config, agentId): Promise<AgentRunResult> => {
      runs++;
      return { agentId, command: ["fake"], exitCode: 0, stdout: "should-not-run", stderr: "", timedOut: false };
    },
    sendTelegram: async () => {
      sends++;
      return { ok: true };
    },
  });

  expect(retry.ledger?.status).toBe("delivered");
  expect(runs).toBe(1);
  expect(sends).toBe(2);
});

test("binding authorization snapshot is enforced", async () => {
  const state = await loadState("/tmp/bridge-state-that-does-not-exist.json");
  const session = createBridgeSession(config, state, { id: "ses_auth", agentId: "echo" });
  attachBridgeSession(config, state, {
    sessionId: session.id,
    channelId: "local",
    conversation: "thread",
    authorization: { from: "allowed" },
  });
  let runs = 0;
  const result = await dispatchMessageWithSessions(config, state, {
    id: "msg-auth",
    channelId: "local",
    chatId: "thread",
    from: "other",
    text: "hello",
    receivedAt: new Date(0).toISOString(),
  }, {
    run: async (_config, agentId): Promise<AgentRunResult> => {
      runs++;
      return { agentId, command: ["fake"], exitCode: 0, stdout: "bad", stderr: "", timedOut: false };
    },
  });

  expect(result.session?.status).toBe("unauthorized");
  expect(result.ledger?.status).toBe("unauthorized");
  expect(runs).toBe(0);
});

test("unauthorized Telegram messages become terminal without invoking an agent", async () => {
  const state = await loadState("/tmp/bridge-state-that-does-not-exist.json");
  let calls = 0;
  const result = await dispatchMessageWithSessions(config, state, {
    id: "telegram:100",
    channelId: "tg",
    chatId: "2",
    text: "hello",
    receivedAt: new Date(0).toISOString(),
  }, {
    run: async (_config, agentId): Promise<AgentRunResult> => {
      calls++;
      return { agentId, command: ["fake"], exitCode: 0, stdout: "bad", stderr: "", timedOut: false };
    },
  });

  expect(result.session?.status).toBe("unauthorized");
  expect(result.ledger?.status).toBe("unauthorized");
  expect(calls).toBe(0);
});
