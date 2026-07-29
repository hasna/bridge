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

test("a description that echoes the request URI never retains the token", async () => {
  // A self-hosted telegram-bot-api or a corporate proxy in front of
  // BRIDGE_TELEGRAM_API_BASE can echo the request URI back in `description`.
  // The token must be stripped from the stored property, not only the message:
  // Bun's uncaught-error printer dumps an error's own properties.
  const server = Bun.serve({
    port: 0,
    fetch: (request) => Response.json(
      { ok: false, error_code: 404, description: `Cannot GET ${new URL(request.url).pathname}` },
      { status: 404 },
    ),
  });
  process.env["BRIDGE_TELEGRAM_API_BASE"] = `http://127.0.0.1:${server.port}`;
  try {
    const err = await getTelegramUpdates(TOKEN, { timeoutSeconds: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect((err as TelegramApiError).description).toBeDefined();
    expect((err as TelegramApiError).description).not.toContain(TOKEN);
    expect(errorSurface(err)).not.toContain(TOKEN);
    expect(errorSurface(err)).not.toContain("SUPER-SECRET");
  } finally {
    server.stop(true);
  }
});

test("a whitespace-padded token is still redacted", async () => {
  // `export TOKEN=$(cat tokenfile)` keeps a trailing newline. WHATWG URL parsing
  // strips \n/\r/\t, so the CLEAN token goes on the wire while an exact-substring
  // redaction searches for the padded value and matches nothing.
  const padded = `${TOKEN}\n`;
  const server = Bun.serve({
    port: 0,
    fetch: (request) => Response.json(
      { ok: false, error_code: 404, description: `Cannot GET ${new URL(request.url).pathname}` },
      { status: 404 },
    ),
  });
  process.env["BRIDGE_TELEGRAM_API_BASE"] = `http://127.0.0.1:${server.port}`;
  try {
    const err = await getTelegramUpdates(padded, { timeoutSeconds: 1 }).catch((e) => e);
    expect(errorSurface(err)).not.toContain(TOKEN);
    expect(errorSurface(err)).not.toContain("SUPER-SECRET");
  } finally {
    server.stop(true);
  }

  process.env["BRIDGE_TELEGRAM_API_BASE"] = "http://127.0.0.1:1";
  const netErr = await getTelegramUpdates(padded, { timeoutSeconds: 1 }).catch((e) => e);
  expect(errorSurface(netErr)).not.toContain(TOKEN);
  expect(errorSurface(netErr)).not.toContain("SUPER-SECRET");
});

test("any bot-token-shaped path segment is redacted, not just the token we hold", async () => {
  // Structural defence: a proxy can echo a redirect, a different bot's path, or a
  // percent-encoded form. Value-only redaction misses all three.
  const other = "987654:ANOTHER-BOTS-SECRET-TOKEN-X";
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json(
      {
        ok: false,
        error_code: 404,
        description: `upstream /bot${other}/getUpdates and /bot${encodeURIComponent(TOKEN)}/getUpdates both failed`,
      },
      { status: 404 },
    ),
  });
  process.env["BRIDGE_TELEGRAM_API_BASE"] = `http://127.0.0.1:${server.port}`;
  try {
    const err = await getTelegramUpdates(TOKEN, { timeoutSeconds: 1 }).catch((e) => e);
    const surface = errorSurface(err);
    expect(surface).not.toContain(other);
    expect(surface).not.toContain("ANOTHER-BOTS-SECRET");
    expect(surface).not.toContain(encodeURIComponent(TOKEN));
    expect(surface).not.toContain("SUPER-SECRET");
  } finally {
    server.stop(true);
  }
});

test("a bare token echoed without the /bot prefix is redacted even when padded", async () => {
  // The structural sweep only matches `/bot<id>:<secret>` path segments. An
  // upstream that parses the credential out and logs it bare ("unknown bot
  // credential: <token>") escapes it, so the value pass must cover the trimmed
  // form too — the padded env value never appears on the wire.
  const padded = `${TOKEN}\n`;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const segment = new URL(request.url).pathname.split("/")[1] || "";
      return Response.json(
        { ok: false, error_code: 401, description: `unknown bot credential: ${segment.slice(3)}` },
        { status: 401 },
      );
    },
  });
  process.env["BRIDGE_TELEGRAM_API_BASE"] = `http://127.0.0.1:${server.port}`;
  try {
    const err = await getTelegramUpdates(padded, { timeoutSeconds: 1 }).catch((e) => e);
    const surface = errorSurface(err);
    expect(surface).not.toContain(TOKEN);
    expect(surface).not.toContain("SUPER-SECRET");
    expect((err as TelegramApiError).description).toContain("[redacted-secret]");
  } finally {
    server.stop(true);
  }
});

test("the public bot id survives redaction while the secret half does not", async () => {
  // `<bot_id>:<secret>` — the id before the colon is the bot's public user id
  // (returned by getMe, visible to anyone who can message the bot), so it is not
  // a credential. Preserving it keeps the most useful field for diagnosing a
  // self-hosted telegram-bot-api routing problem at no cost to protection.
  // This test exists so a later "simplification" of the regex cannot silently
  // re-broaden redaction back over the id.
  const other = "987654:ANOTHER-BOTS-SECRET-TOKEN-X";
  const server = Bun.serve({
    port: 0,
    fetch: (request) => Response.json(
      {
        ok: false,
        error_code: 404,
        description: `route failed: /bot${other}/getUpdates then ${new URL(request.url).pathname}`,
      },
      { status: 404 },
    ),
  });
  process.env["BRIDGE_TELEGRAM_API_BASE"] = `http://127.0.0.1:${server.port}`;
  try {
    const err = await getTelegramUpdates(TOKEN, { timeoutSeconds: 1 }).catch((e) => e);
    const description = (err as TelegramApiError).description ?? "";

    // Both bot ids survive — ours, and the neighbouring one the proxy echoed.
    expect(description).toContain("/bot111222:");
    expect(description).toContain("/bot987654:");
    expect(description).toContain("[redacted-secret]");

    // Neither secret does.
    expect(description).not.toContain("SUPER-SECRET");
    expect(description).not.toContain("ANOTHER-BOTS-SECRET");
    expect(errorSurface(err)).not.toContain(TOKEN);
    expect(errorSurface(err)).not.toContain(other);
  } finally {
    server.stop(true);
  }
});

test("a self-hosted token whose secret contains URL metacharacters is fully redacted", async () => {
  // BRIDGE_TELEGRAM_API_BASE supports a self-hosted telegram-bot-api, so the
  // secret must not be assumed to use Telegram's own [A-Za-z0-9_-] charset.
  // A secret containing `+` and `/` defeats the structural sweep twice over: the
  // character class excludes `/`, and `+` cuts the run below the {20,} floor. The
  // value pass is the only defence, and it needs the percent-encoded form for a
  // proxy that echoes an encoded path.
  const selfHosted = "555777:selfhosted+secret/value-0123456789";
  const secret = "selfhosted+secret/value-0123456789";
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      return Response.json(
        { ok: false, error_code: 404, description: `Cannot GET ${pathname} (encoded ${encodeURIComponent(pathname)})` },
        { status: 404 },
      );
    },
  });
  process.env["BRIDGE_TELEGRAM_API_BASE"] = `http://127.0.0.1:${server.port}`;
  try {
    const err = await getTelegramUpdates(selfHosted, { timeoutSeconds: 1 }).catch((e) => e);
    const surface = errorSurface(err);
    expect(surface).not.toContain(secret);
    expect(surface).not.toContain(encodeURIComponent(secret));
    // No surviving fragment of either form.
    expect(surface).not.toContain("selfhosted");
    expect(surface).not.toContain("value-0123456789");
  } finally {
    server.stop(true);
  }
});
