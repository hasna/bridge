import { expect, test } from "bun:test";
import {
  dispatchMessageWithSessions,
  ensureConversationBinding,
  resolveAutoAgentId,
  telegramUpdateToMessage,
  type AgentRunResult,
  type BridgeConfig,
  type BridgeState,
} from "../src/index.js";

const config: BridgeConfig = {
  version: 1,
  channels: {
    tg: {
      id: "tg",
      kind: "telegram",
      enabled: true,
      botTokenEnv: "TG_TOKEN",
      allowedChatIds: ["1"],
      defaultAgentId: "echo",
    },
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

test("inbound reply auto-attaches a session to the channel default agent and routes to it", async () => {
  process.env["TG_TOKEN"] = "test-token";
  const bridgeState = state();
  let prompt = "";
  let sent: { chatId: string; text: string } | undefined;

  const result = await dispatchMessageWithSessions(config, bridgeState, {
    id: "telegram:1",
    channelId: "tg",
    chatId: "1",
    text: "first reply",
    receivedAt: new Date(0).toISOString(),
  }, {
    run: async (_config, agentId, input): Promise<AgentRunResult> => {
      prompt = input.message.text;
      return { agentId, command: ["fake"], exitCode: 0, stdout: `reply: ${prompt}`, stderr: "", timedOut: false };
    },
    sendTelegram: async (_token, chatId, text) => {
      sent = { chatId, text };
      return { ok: true };
    },
  });

  expect(prompt).toBe("first reply");
  expect(result.session?.status).toBe("delivered");
  expect(result.ledger?.status).toBe("delivered");
  expect(sent).toEqual({ chatId: "1", text: "reply: first reply" });
  // A durable binding + session now exist for the conversation.
  const binding = bridgeState.bindings["tg::telegram:tg:1"];
  expect(binding).toBeDefined();
  expect(binding?.activeSessionId).toMatch(/^ses_/);
});

test("second reply resumes the same auto-created session (no duplicate binding/session)", async () => {
  process.env["TG_TOKEN"] = "test-token";
  const bridgeState = state();
  const run = async (_config: BridgeConfig, agentId: string): Promise<AgentRunResult> => ({
    agentId, command: ["fake"], exitCode: 0, stdout: "ok", stderr: "", timedOut: false,
  });
  const sendTelegram = async () => ({ ok: true });

  await dispatchMessageWithSessions(config, bridgeState, {
    id: "telegram:1", channelId: "tg", chatId: "1", text: "one", receivedAt: new Date(0).toISOString(),
  }, { run, sendTelegram });
  const firstSession = bridgeState.bindings["tg::telegram:tg:1"]?.activeSessionId;

  await dispatchMessageWithSessions(config, bridgeState, {
    id: "telegram:2", channelId: "tg", chatId: "1", text: "two", receivedAt: new Date(0).toISOString(),
  }, { run, sendTelegram });
  const secondSession = bridgeState.bindings["tg::telegram:tg:1"]?.activeSessionId;

  expect(firstSession).toBe(secondSession);
  expect(Object.keys(bridgeState.sessions).length).toBe(1);
  expect(Object.keys(bridgeState.bindings).length).toBe(1);
});

test("unauthorized chat never provisions an auto-session", async () => {
  process.env["TG_TOKEN"] = "test-token";
  const bridgeState = state();
  let calls = 0;

  const result = await dispatchMessageWithSessions(config, bridgeState, {
    id: "telegram:9", channelId: "tg", chatId: "999", text: "spam", receivedAt: new Date(0).toISOString(),
  }, {
    run: async (_config, agentId): Promise<AgentRunResult> => {
      calls++;
      return { agentId, command: ["fake"], exitCode: 0, stdout: "bad", stderr: "", timedOut: false };
    },
    sendTelegram: async () => ({ ok: true }),
  });

  expect(calls).toBe(0);
  expect(result.session?.status).toBe("unauthorized");
  expect(Object.keys(bridgeState.sessions).length).toBe(0);
  expect(Object.keys(bridgeState.bindings).length).toBe(0);
});

test("ensureConversationBinding throws on a misconfigured default agent", () => {
  const badConfig: BridgeConfig = {
    ...config,
    channels: { tg: { ...config.channels.tg, defaultAgentId: "missing" } as BridgeConfig["channels"][string] },
  };
  expect(() => ensureConversationBinding(badConfig, state(), {
    id: "telegram:1", channelId: "tg", chatId: "1", text: "x", receivedAt: new Date(0).toISOString(),
  })).toThrow("defaultAgentId not found");
});

// The owner chat is allowlisted but the channel has no defaultAgentId set. An
// inbound reply must still auto-provision the sole codewith agent rather than
// bounce back the "no session" help text.
const OWNER_CHAT = "1225577096";
const ownerConfig: BridgeConfig = {
  version: 1,
  channels: {
    tg: { id: "tg", kind: "telegram", enabled: true, botTokenEnv: "TG_TOKEN", allowedChatIds: [OWNER_CHAT] },
  },
  profiles: { cw: { id: "cw", agentKind: "codewith", authProfile: "account088" } },
  agents: { cw: { id: "cw", kind: "codewith", profileId: "cw" } },
  routes: [],
};

test("resolveAutoAgentId falls back to the sole codewith agent when no defaultAgentId", () => {
  expect(resolveAutoAgentId(ownerConfig, ownerConfig.channels.tg)).toBe("cw");
  // Explicit defaultAgentId always wins.
  const withDefault = { ...ownerConfig.channels.tg, defaultAgentId: "other" };
  expect(resolveAutoAgentId(ownerConfig, withDefault)).toBe("other");
  // Ambiguous config (two codewith agents, none defaulted) refuses to guess.
  const ambiguous: BridgeConfig = {
    ...ownerConfig,
    agents: { a: { id: "a", kind: "codewith" }, b: { id: "b", kind: "codewith" } },
  };
  expect(resolveAutoAgentId(ambiguous, ambiguous.channels.tg)).toBeUndefined();
});

test("owner chat with no defaultAgentId still auto-provisions an agent (not the no-session help text)", async () => {
  process.env["TG_TOKEN"] = "test-token";
  const bridgeState = state();
  let ran = false;
  let sent = "";
  const result = await dispatchMessageWithSessions(ownerConfig, bridgeState, {
    id: "telegram:1", channelId: "tg", chatId: OWNER_CHAT, text: "hello", receivedAt: new Date(0).toISOString(),
  }, {
    run: async (_c, agentId): Promise<AgentRunResult> => {
      ran = true;
      return { agentId, command: ["fake"], exitCode: 0, stdout: "hi back", stderr: "", timedOut: false };
    },
    sendTelegram: async (_t, _c, text) => { sent = text; return { ok: true }; },
  });
  expect(ran).toBe(true);
  expect(sent).toBe("hi back");
  expect(result.session?.status).toBe("delivered");
  expect(sent).not.toContain("No bridge session");
  const binding = bridgeState.bindings[`tg::telegram:tg:${OWNER_CHAT}`];
  expect(binding?.activeSessionId).toMatch(/^ses_/);
});

test("malformed / non-text Telegram updates are dropped without throwing", () => {
  // Non-message update kinds (edited/callback/etc.) surface as undefined here.
  expect(telegramUpdateToMessage("tg", { update_id: 5 })).toBeUndefined();
  // Photo/sticker with no text.
  expect(telegramUpdateToMessage("tg", {
    update_id: 6, message: { message_id: 1, chat: { id: 1 } },
  })).toBeUndefined();
  // Missing chat.
  expect(telegramUpdateToMessage("tg", {
    update_id: 7, message: { message_id: 2, text: "hi" } as never,
  })).toBeUndefined();
  // Valid one still parses.
  const ok = telegramUpdateToMessage("tg", {
    update_id: 8, message: { message_id: 3, text: "hi", chat: { id: 1 } },
  });
  expect(ok?.text).toBe("hi");
});

test("a message with no conversation id (no chatId) does not crash dispatch", async () => {
  const bridgeState = state();
  const result = await dispatchMessageWithSessions(config, bridgeState, {
    id: "telegram:nochat", channelId: "tg", text: "orphan", receivedAt: new Date(0).toISOString(),
  }, {
    run: async (_config, agentId): Promise<AgentRunResult> => ({
      agentId, command: ["fake"], exitCode: 0, stdout: "x", stderr: "", timedOut: false,
    }),
    sendTelegram: async () => ({ ok: true }),
  });
  // No chatId -> unauthorized channel gate -> terminal, no throw, no session created.
  expect(result.ledger?.status).toBeDefined();
  expect(Object.keys(bridgeState.sessions).length).toBe(0);
});
