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

export async function sendTelegramMessage(token: string, chatId: string, text: string): Promise<unknown> {
  const response = await fetch(telegramMethodUrl(token, "sendMessage"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(`Telegram sendMessage failed (${response.status}): ${JSON.stringify(body)}`);
  return body;
}

export async function getTelegramUpdates(
  token: string,
  options: { offset?: number; timeoutSeconds?: number } = {},
): Promise<TelegramUpdate[]> {
  const params = new URLSearchParams();
  if (options.offset !== undefined) params.set("offset", String(options.offset));
  params.set("timeout", String(options.timeoutSeconds ?? 20));
  const response = await fetch(`${telegramMethodUrl(token, "getUpdates")}?${params.toString()}`);
  const body = await response.json().catch(() => undefined) as { ok?: boolean; result?: TelegramUpdate[] };
  if (!response.ok || !body?.ok) {
    throw new Error(`Telegram getUpdates failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body.result || [];
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
