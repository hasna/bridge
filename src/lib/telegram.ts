import type { BridgeMessage, TelegramChannelConfig } from "../types.js";

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    message_thread_id?: number;
    chat: { id: number | string; type?: string; username?: string };
    from?: { id: number | string; username?: string; first_name?: string };
    date?: number;
  };
}

const DEFAULT_TELEGRAM_API_BASE = "https://api.telegram.org";

export interface TelegramApiBaseInfo {
  overridden: boolean;
  origin: string;
  pathname: string;
}

function telegramApiBase(): URL {
  const raw = process.env["BRIDGE_TELEGRAM_API_BASE"] || DEFAULT_TELEGRAM_API_BASE;
  const parsed = new URL(raw);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("BRIDGE_TELEGRAM_API_BASE must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("BRIDGE_TELEGRAM_API_BASE must not contain credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("BRIDGE_TELEGRAM_API_BASE must not contain query strings or fragments");
  }
  return parsed;
}

export function telegramApiBaseInfo(): TelegramApiBaseInfo {
  const parsed = telegramApiBase();
  return {
    overridden: parsed.href.replace(/\/$/, "") !== DEFAULT_TELEGRAM_API_BASE,
    origin: parsed.origin,
    pathname: parsed.pathname,
  };
}

function telegramMethodUrl(token: string, method: string): string {
  const base = telegramApiBase();
  const prefix = base.pathname.replace(/\/$/, "");
  base.pathname = `${prefix}/bot${token}/${method}`;
  base.search = "";
  return base.toString();
}

export function telegramToken(channel: TelegramChannelConfig): string {
  const envName = channel.botTokenEnv || "TELEGRAM_BOT_TOKEN";
  const token = process.env[envName];
  if (!token) throw new Error(`Missing Telegram bot token env var: ${envName}`);
  return token;
}

export function telegramChatAllowed(channel: TelegramChannelConfig, chatId: string | undefined): boolean {
  if (channel.allowAllChats) return true;
  if (!channel.allowedChatIds?.length) return false;
  return Boolean(chatId && channel.allowedChatIds.includes(chatId));
}

/**
 * Outbound broadcast allowlist (mirrors the inbound allowedChatIds pattern):
 * a chat id may only be broadcast to when it is listed in broadcastChatIds or
 * allowAllBroadcasts is explicitly enabled.
 */
export function telegramBroadcastAllowed(channel: TelegramChannelConfig, chatId: string | undefined): boolean {
  if (channel.allowAllBroadcasts) return true;
  if (!channel.broadcastChatIds?.length) return false;
  return Boolean(chatId && channel.broadcastChatIds.includes(chatId));
}

export interface TelegramApiErrorInit {
  method: string;
  status?: number;
  description?: string;
  /** Seconds Telegram asked us to wait before retrying (429 `parameters.retry_after`). */
  retryAfterSeconds?: number;
  /** True when the request was cancelled through the caller's AbortSignal. */
  aborted?: boolean;
}

/**
 * Every failure raised out of this module, deliberately sanitised.
 *
 * The bot token is embedded in the Telegram request URL, and the runtime's own
 * network errors carry that URL (Bun exposes it as `err.path`). Letting a raw
 * error escape therefore prints the bot token to the terminal and to the daemon
 * stderr log.
 *
 * Nothing here ever stores or re-exposes the URL, and EVERY field built from
 * borrowed text — `message` and `description` alike — is passed through
 * {@link redactToken} first. That matters beyond `message`: Bun's uncaught-error
 * printer dumps an error's own properties, so a token surviving on `description`
 * is just as exposed as one in the message.
 */
export class TelegramApiError extends Error {
  readonly method: string;
  readonly status: number | undefined;
  readonly description: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly aborted: boolean;

  constructor(message: string, init: TelegramApiErrorInit) {
    super(message);
    this.name = "TelegramApiError";
    this.method = init.method;
    this.status = init.status;
    this.description = init.description;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.aborted = init.aborted ?? false;
  }
}

const REDACTED_TOKEN = "[redacted-token]";

/**
 * Any `/bot<id>:<secret>` path segment, whatever token it holds.
 *
 * The structural pass is what makes redaction robust: matching only the token we
 * were handed misses a proxy echoing a redirect, another bot's path, or a
 * percent-encoded form. `%` and `.` are in the class so a percent-escaped or
 * dot-bearing secret is consumed whole rather than half-redacted.
 */
const BOT_TOKEN_PATH = /\/bot\d{5,}(?::|%3A|%3a)[A-Za-z0-9_%.-]{20,}/g;

/**
 * Strip the bot token from any text borrowed from another error or an upstream
 * response, by value AND by shape.
 *
 * The value pass alone is not enough. WHATWG URL parsing strips `\n`, `\r` and
 * `\t`, so a token read with `export TOKEN=$(cat tokenfile)` (trailing newline)
 * goes on the wire CLEAN while an exact-substring search for the padded value
 * matches nothing. Hence: the raw value, its trimmed form, and its
 * percent-encoded forms, then the structural sweep as the backstop.
 */
function redactToken(text: string, token: string): string {
  let out = text;
  const variants = new Set<string>();
  for (const candidate of [token, token.trim()]) {
    if (!candidate) continue;
    variants.add(candidate);
    variants.add(encodeURIComponent(candidate));
  }
  // Longest first, so a shorter variant cannot leave a fragment of a longer one.
  for (const variant of [...variants].sort((a, b) => b.length - a.length)) {
    out = out.split(variant).join(REDACTED_TOKEN);
  }
  return out.replace(BOT_TOKEN_PATH, `/bot${REDACTED_TOKEN}`);
}

interface TelegramResponseBody {
  ok?: boolean;
  description?: string;
  parameters?: { retry_after?: unknown };
  result?: unknown;
}

function retryAfterSeconds(body: TelegramResponseBody | undefined, response: Response): number | undefined {
  const fromBody = body?.parameters?.retry_after;
  if (typeof fromBody === "number" && Number.isFinite(fromBody) && fromBody >= 0) return fromBody;
  const header = Number.parseInt(response.headers.get("retry-after") || "", 10);
  return Number.isFinite(header) && header >= 0 ? header : undefined;
}

async function telegramRequest(
  token: string,
  method: string,
  url: string,
  init: RequestInit = {},
): Promise<TelegramResponseBody> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    // NEVER rethrow the raw error: it carries the token-bearing request URL.
    const aborted = Boolean(init.signal?.aborted);
    const detail = redactToken(err instanceof Error ? err.message : String(err), token);
    throw new TelegramApiError(
      aborted ? `Telegram ${method} request aborted` : `Telegram ${method} request failed: ${detail}`,
      { method, aborted },
    );
  }

  const body = await response.json().catch(() => undefined) as TelegramResponseBody | undefined;
  if (!response.ok || !body?.ok) {
    // Redact ONCE, up front: `description` is stored on the error as a public
    // property, so it must be sanitised exactly like the message.
    const description = typeof body?.description === "string"
      ? redactToken(body.description, token)
      : undefined;
    throw new TelegramApiError(
      `Telegram ${method} failed (${response.status}): ${description || "no description"}`,
      { method, status: response.status, description, retryAfterSeconds: retryAfterSeconds(body, response) },
    );
  }
  return body;
}

export async function sendTelegramMessage(token: string, chatId: string, text: string): Promise<unknown> {
  return telegramRequest(token, "sendMessage", telegramMethodUrl(token, "sendMessage"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

/** A getUpdates entry is only usable if it carries the numeric update_id the offset depends on. */
function isUsableUpdate(value: unknown): value is TelegramUpdate {
  return Boolean(
    value
    && typeof value === "object"
    && Number.isInteger((value as { update_id?: unknown }).update_id),
  );
}

export async function getTelegramUpdates(
  token: string,
  options: { offset?: number; timeoutSeconds?: number; signal?: AbortSignal } = {},
): Promise<TelegramUpdate[]> {
  const params = new URLSearchParams();
  if (options.offset !== undefined) params.set("offset", String(options.offset));
  params.set("timeout", String(options.timeoutSeconds ?? 20));
  const init: RequestInit = options.signal ? { signal: options.signal } : {};
  const body = await telegramRequest(
    token,
    "getUpdates",
    `${telegramMethodUrl(token, "getUpdates")}?${params.toString()}`,
    init,
  );
  if (!Array.isArray(body.result)) {
    // A proxy or captive portal can answer 200/ok with a non-array result;
    // iterating it throws deep in the poll loop instead of here.
    throw new TelegramApiError("Telegram getUpdates returned a malformed result (expected an array)", {
      method: "getUpdates",
    });
  }
  // Drop entries without a numeric update_id: the poll offset is derived from
  // it, and `undefined + 1` would persist NaN and permanently break the cursor.
  return body.result.filter(isUsableUpdate);
}

export function telegramUpdateToMessage(channelId: string, update: TelegramUpdate): BridgeMessage | undefined {
  const text = update.message?.text;
  const chatId = update.message?.chat?.id;
  if (!text || chatId === undefined) return undefined;
  return {
    id: `telegram:${update.update_id}`,
    channelId,
    text,
    chatId: String(chatId),
    threadId: update.message?.message_thread_id !== undefined ? String(update.message.message_thread_id) : undefined,
    from: update.message?.from?.username || (update.message?.from?.id !== undefined ? String(update.message.from.id) : undefined),
    receivedAt: update.message?.date ? new Date(update.message.date * 1000).toISOString() : new Date().toISOString(),
    raw: update,
  };
}
