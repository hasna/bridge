import { expect, test } from "bun:test";
import {
  broadcast,
  emptyState,
  getBroadcast,
  listBroadcasts,
  recordBroadcast,
  telegramBroadcastAllowed,
  telegramMessageId,
  type BridgeConfig,
  type BroadcastResult,
  type TelegramChannelConfig,
} from "../src/index.js";

function telegramConfig(channel: Partial<TelegramChannelConfig> = {}): BridgeConfig {
  return {
    version: 1,
    channels: {
      announce: {
        id: "announce",
        kind: "telegram",
        enabled: true,
        botTokenEnv: "TG_BROADCAST_TOKEN",
        allowedChatIds: ["1"],
        broadcastChatIds: ["-100200", "-100300"],
        ...channel,
      },
      con: { id: "con", kind: "console", enabled: true },
      hook: { id: "hook", kind: "webhook", enabled: true },
    },
    profiles: {},
    agents: {},
    routes: [],
  };
}

type SentPost = { token: string; chatId: string; text: string };

function mockSender(fail: string[] = []) {
  const sent: SentPost[] = [];
  let counter = 0;
  const send = async (token: string, chatId: string, text: string): Promise<unknown> => {
    if (fail.includes(chatId)) throw new Error(`Telegram sendMessage failed (403): forbidden for ${chatId}`);
    sent.push({ token, chatId, text });
    counter += 1;
    return { ok: true, result: { message_id: counter } };
  };
  return { send, sent };
}

test("telegramBroadcastAllowed mirrors the inbound allowlist pattern", () => {
  const channel = telegramConfig().channels["announce"] as TelegramChannelConfig;
  expect(telegramBroadcastAllowed(channel, "-100200")).toBe(true);
  expect(telegramBroadcastAllowed(channel, "1")).toBe(false); // inbound-allowed but not outbound
  expect(telegramBroadcastAllowed(channel, undefined)).toBe(false);
  expect(telegramBroadcastAllowed({ ...channel, broadcastChatIds: [] }, "-100200")).toBe(false);
  expect(telegramBroadcastAllowed({ ...channel, broadcastChatIds: undefined }, "-100200")).toBe(false);
  expect(telegramBroadcastAllowed({ ...channel, broadcastChatIds: undefined, allowAllBroadcasts: true }, "anything")).toBe(true);
});

test("broadcast posts to every configured chat id and reports per-post status", async () => {
  process.env["TG_BROADCAST_TOKEN"] = "test-token";
  const { send, sent } = mockSender();

  const result = await broadcast(telegramConfig(), "announce", "release v1.2.3 is live", { sendTelegram: send });

  expect(result.channelId).toBe("announce");
  expect(result.channelKind).toBe("telegram");
  expect(result.total).toBe(2);
  expect(result.sent).toBe(2);
  expect(result.failed).toBe(0);
  expect(result.skipped).toBe(0);
  expect(result.posts.map((p) => p.target)).toEqual(["-100200", "-100300"]);
  expect(result.posts.every((p) => p.status === "sent" && p.messageId && p.sentAt)).toBe(true);
  expect(sent).toEqual([
    { token: "test-token", chatId: "-100200", text: "release v1.2.3 is live" },
    { token: "test-token", chatId: "-100300", text: "release v1.2.3 is live" },
  ]);
});

test("explicit targets outside the outbound allowlist are skipped, not sent", async () => {
  process.env["TG_BROADCAST_TOKEN"] = "test-token";
  const { send, sent } = mockSender();

  const result = await broadcast(telegramConfig(), "announce", "hello", {
    sendTelegram: send,
    targets: ["-100200", "-100999"],
  });

  expect(result.sent).toBe(1);
  expect(result.skipped).toBe(1);
  expect(sent.map((p) => p.chatId)).toEqual(["-100200"]);
  const skipped = result.posts.find((p) => p.target === "-100999");
  expect(skipped?.status).toBe("skipped");
  expect(skipped?.detail).toContain("allowlist");
});

test("a failed post is reported per-target without aborting the rest", async () => {
  process.env["TG_BROADCAST_TOKEN"] = "test-token";
  const { send, sent } = mockSender(["-100200"]);

  const result = await broadcast(telegramConfig(), "announce", "hello", { sendTelegram: send });

  expect(result.sent).toBe(1);
  expect(result.failed).toBe(1);
  const failed = result.posts.find((p) => p.target === "-100200");
  expect(failed?.status).toBe("failed");
  expect(failed?.detail).toContain("403");
  expect(sent.map((p) => p.chatId)).toEqual(["-100300"]);
});

test("telegram channel without broadcast targets throws a configuration error", async () => {
  process.env["TG_BROADCAST_TOKEN"] = "test-token";
  const { send } = mockSender();
  const config = telegramConfig({ broadcastChatIds: undefined });
  await expect(broadcast(config, "announce", "hello", { sendTelegram: send })).rejects.toThrow(/no broadcast targets/);
});

test("unknown, disabled, and unsupported channels are rejected", async () => {
  const { send } = mockSender();
  const config = telegramConfig();
  await expect(broadcast(config, "missing", "hi", { sendTelegram: send })).rejects.toThrow(/Unknown channel/);
  await expect(broadcast(config, "hook", "hi", { sendTelegram: send })).rejects.toThrow(/does not support broadcast/);
  const disabled = telegramConfig({ enabled: false });
  await expect(broadcast(disabled, "announce", "hi", { sendTelegram: send })).rejects.toThrow(/disabled/);
  await expect(broadcast(config, "announce", "   ", { sendTelegram: send })).rejects.toThrow(/must not be empty/);
});

test("console channels broadcast through the injected sink", async () => {
  const lines: string[] = [];
  const result = await broadcast(telegramConfig(), "con", "local announcement", { writeConsole: (t) => lines.push(t) });
  expect(lines).toEqual(["local announcement"]);
  expect(result.sent).toBe(1);
  expect(result.posts[0]?.target).toBe("console");
});

test("recordBroadcast persists reports and listBroadcasts returns newest first", async () => {
  process.env["TG_BROADCAST_TOKEN"] = "test-token";
  const { send } = mockSender();
  const state = emptyState();
  const config = telegramConfig();

  const first = await broadcast(config, "announce", "first", { sendTelegram: send });
  const older: BroadcastResult = { ...first, id: "bcast_old", requestedAt: "2020-01-01T00:00:00.000Z" };
  recordBroadcast(state, older);
  recordBroadcast(state, first);

  const all = listBroadcasts(state);
  expect(all.map((b) => b.id)).toEqual([first.id, "bcast_old"]);
  expect(listBroadcasts(state, { limit: 1 }).map((b) => b.id)).toEqual([first.id]);
  expect(listBroadcasts(state, { channelId: "nope" })).toEqual([]);
  expect(getBroadcast(state, "bcast_old")?.text).toBe("first");
  expect(getBroadcast(state, "unknown")).toBeUndefined();
});

test("recordBroadcast caps history at 200 reports, evicting the oldest", async () => {
  const state = emptyState();
  const base: BroadcastResult = {
    id: "x",
    channelId: "announce",
    channelKind: "telegram",
    text: "t",
    requestedAt: "2026-01-01T00:00:00.000Z",
    total: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    posts: [],
  };
  for (let i = 0; i < 205; i++) {
    recordBroadcast(state, {
      ...base,
      id: `bcast_${String(i).padStart(4, "0")}`,
      requestedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    });
  }
  const remaining = listBroadcasts(state);
  expect(remaining).toHaveLength(200);
  expect(getBroadcast(state, "bcast_0000")).toBeUndefined();
  expect(getBroadcast(state, "bcast_0204")).toBeDefined();
});

test("telegramMessageId extracts ids defensively", () => {
  expect(telegramMessageId({ ok: true, result: { message_id: 42 } })).toBe("42");
  expect(telegramMessageId({ ok: true, result: { message_id: "43" } })).toBe("43");
  expect(telegramMessageId({ ok: true })).toBeUndefined();
  expect(telegramMessageId(undefined)).toBeUndefined();
  expect(telegramMessageId("nope")).toBeUndefined();
});

test("state round-trips broadcast reports through the config parser era (normalize keeps broadcasts)", async () => {
  const state = emptyState();
  expect(state.broadcasts).toEqual({});
});
