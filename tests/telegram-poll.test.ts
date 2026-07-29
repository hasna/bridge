import { afterEach, expect, test } from "bun:test";
import {
  TelegramApiError,
  getTelegramUpdates,
  sendTelegramMessage,
} from "../src/index.js";

const TOKEN = "111222:SUPER-SECRET-BOT-TOKEN";

afterEach(() => {
  delete process.env["BRIDGE_TELEGRAM_API_BASE"];
});

/** Every own property of the error, so a leak hidden in a non-message field is caught. */
function errorSurface(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return [
    err.name,
    err.message,
    String(err.stack ?? ""),
    JSON.stringify(err, Object.getOwnPropertyNames(err)),
  ].join("\n");
}

test("a network failure never exposes the bot token", async () => {
  // Port 1 is refused; Bun attaches the full request URL (which embeds the bot
  // token) to the thrown error, so the raw error must never escape.
  process.env["BRIDGE_TELEGRAM_API_BASE"] = "http://127.0.0.1:1";

  const pollError = await getTelegramUpdates(TOKEN, { timeoutSeconds: 1 }).catch((err) => err);
  expect(pollError).toBeInstanceOf(TelegramApiError);
  expect(errorSurface(pollError)).not.toContain(TOKEN);
  expect(errorSurface(pollError)).not.toContain("SUPER-SECRET");

  const sendError = await sendTelegramMessage(TOKEN, "1", "hi").catch((err) => err);
  expect(sendError).toBeInstanceOf(TelegramApiError);
  expect(errorSurface(sendError)).not.toContain(TOKEN);
});

test("an HTTP error response never exposes the bot token", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 }),
  });
  process.env["BRIDGE_TELEGRAM_API_BASE"] = `http://127.0.0.1:${server.port}`;
  try {
    const err = await getTelegramUpdates(TOKEN, { timeoutSeconds: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect((err as TelegramApiError).status).toBe(401);
    expect(err.message).toContain("Unauthorized");
    expect(errorSurface(err)).not.toContain(TOKEN);
  } finally {
    server.stop(true);
  }
});

test("getUpdates surfaces the Telegram 429 retry_after so the poller can back off", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json(
      { ok: false, error_code: 429, description: "Too Many Requests: retry later", parameters: { retry_after: 7 } },
      { status: 429 },
    ),
  });
  process.env["BRIDGE_TELEGRAM_API_BASE"] = `http://127.0.0.1:${server.port}`;
  try {
    const err = await getTelegramUpdates(TOKEN, { timeoutSeconds: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect((err as TelegramApiError).status).toBe(429);
    expect((err as TelegramApiError).retryAfterSeconds).toBe(7);
  } finally {
    server.stop(true);
  }
});

test("sendMessage surfaces the Telegram 429 retry_after", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json(
      { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } },
      { status: 429 },
    ),
  });
  process.env["BRIDGE_TELEGRAM_API_BASE"] = `http://127.0.0.1:${server.port}`;
  try {
    const err = await sendTelegramMessage(TOKEN, "1", "hi").catch((e) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect((err as TelegramApiError).status).toBe(429);
    expect((err as TelegramApiError).retryAfterSeconds).toBe(3);
  } finally {
    server.stop(true);
  }
});

test("a malformed getUpdates payload is rejected instead of being iterated", async () => {
  const server = Bun.serve({
    port: 0,
    // A proxy / captive portal can answer 200 with a non-array `result`.
    fetch: () => Response.json({ ok: true, result: { "0": { update_id: 1 } } }),
  });
  process.env["BRIDGE_TELEGRAM_API_BASE"] = `http://127.0.0.1:${server.port}`;
  try {
    const err = await getTelegramUpdates(TOKEN, { timeoutSeconds: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect(err.message).toContain("malformed");
  } finally {
    server.stop(true);
  }
});

test("updates without a usable update_id are dropped rather than corrupting the offset", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({
      ok: true,
      result: [
        { message: { message_id: 1, text: "no update id", chat: { id: 1 } } },
        { update_id: 42, message: { message_id: 2, text: "good", chat: { id: 1 } } },
        "not-an-object",
      ],
    }),
  });
  process.env["BRIDGE_TELEGRAM_API_BASE"] = `http://127.0.0.1:${server.port}`;
  try {
    const updates = await getTelegramUpdates(TOKEN, { timeoutSeconds: 1 });
    expect(updates.map((u) => u.update_id)).toEqual([42]);
  } finally {
    server.stop(true);
  }
});

test("an abort signal cancels an in-flight long poll", async () => {
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const server = Bun.serve({
    port: 0,
    async fetch() {
      await held;
      return Response.json({ ok: true, result: [] });
    },
  });
  process.env["BRIDGE_TELEGRAM_API_BASE"] = `http://127.0.0.1:${server.port}`;
  const controller = new AbortController();
  try {
    const pending = getTelegramUpdates(TOKEN, { timeoutSeconds: 30, signal: controller.signal }).catch((e) => e);
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    const err = await pending;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect((err as TelegramApiError).aborted).toBe(true);
    expect(errorSurface(err)).not.toContain(TOKEN);
  } finally {
    release?.();
    server.stop(true);
  }
});
