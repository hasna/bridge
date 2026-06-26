import { expect, test } from "bun:test";
import {
  attachBridgeSession,
  createBridgeSession,
  dispatchMessageWithSessions,
  messageConversationId,
  telegramUpdateToMessage,
  type AgentRunResult,
  type BridgeConfig,
  type BridgeState,
} from "../src/index.js";

const config: BridgeConfig = {
  version: 1,
  channels: {
    tg: { id: "tg", kind: "telegram", enabled: true, botTokenEnv: "TG_TOKEN", allowedChatIds: ["1"] },
  },
  profiles: {},
  agents: {
    echo: { id: "echo", kind: "shell", command: "printf", args: ["ok:{prompt}"] },
  },
  routes: [],
};

function state(): BridgeState {
  return {
    schemaVersion: 2,
    telegramOffsets: {},
    sessions: {},
    bindings: {},
    messageLedger: {},
    cursors: {},
  };
}

test("plain Telegram text routes to the bound session without a prefix", async () => {
  process.env["TG_TOKEN"] = "test-token";
  const bridgeState = state();
  const session = createBridgeSession(config, bridgeState, { id: "ses_tg", agentId: "echo" });
  attachBridgeSession(config, bridgeState, { sessionId: session.id, channelId: "tg", conversation: "1" });
  let sent: { token: string; chatId: string; text: string } | undefined;
  let prompt = "";

  const result = await dispatchMessageWithSessions(config, bridgeState, {
    id: "telegram:1",
    channelId: "tg",
    chatId: "1",
    text: "check if it worksed",
    receivedAt: new Date(0).toISOString(),
  }, {
    run: async (_config, agentId, input): Promise<AgentRunResult> => {
      prompt = input.message.text;
      return { agentId, command: ["fake"], exitCode: 0, stdout: `session ok: ${prompt}`, stderr: "", timedOut: false };
    },
    sendTelegram: async (token, chatId, text) => {
      sent = { token, chatId, text };
      return { ok: true };
    },
  });

  expect(prompt).toBe("check if it worksed");
  expect(result.session?.status).toBe("delivered");
  expect(sent).toEqual({ token: "test-token", chatId: "1", text: "session ok: check if it worksed" });
});

test("Telegram message without an active session responds without invoking an agent", async () => {
  process.env["TG_TOKEN"] = "test-token";
  const bridgeState = state();
  let calls = 0;
  let response = "";

  const result = await dispatchMessageWithSessions(config, bridgeState, {
    id: "telegram:2",
    channelId: "tg",
    chatId: "1",
    text: "hello",
    receivedAt: new Date(0).toISOString(),
  }, {
    run: async (_config, agentId): Promise<AgentRunResult> => {
      calls++;
      return { agentId, command: ["fake"], exitCode: 0, stdout: "bad", stderr: "", timedOut: false };
    },
    sendTelegram: async (_token, _chatId, text) => {
      response = text;
      return { ok: true };
    },
  });

  expect(result.session?.status).toBe("no_session");
  expect(result.ledger?.status).toBe("skipped");
  expect(response).toContain("No bridge session is attached");
  expect(calls).toBe(0);
});

test("Telegram forum topic IDs participate in conversation IDs", () => {
  const message = telegramUpdateToMessage("tg", {
    update_id: 99,
    message: {
      message_id: 10,
      message_thread_id: 44,
      text: "topic text",
      chat: { id: 1, type: "supergroup" },
      date: 0,
    },
  });

  expect(message?.chatId).toBe("1");
  expect(message?.threadId).toBe("44");
  expect(messageConversationId(config, message!)).toBe("telegram:tg:1:44");
});
