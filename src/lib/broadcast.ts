/**
 * Outbound broadcast surface (distribution apps plan).
 *
 * One-to-many posting to a channel's configured targets — for Telegram this is
 * channel/group chat ids (distinct from the inbound routing in telegram.ts).
 * Every target is checked against the outbound allowlist (broadcastChatIds /
 * allowAllBroadcasts, mirroring the inbound allowedChatIds pattern) and every
 * post yields a per-target delivery status that can be persisted in state.
 */
import type {
  BridgeConfig,
  BroadcastPost,
  BroadcastResult,
  ChannelConfig,
  TelegramChannelConfig,
} from "../types.js";
import type { BridgeState } from "./state.js";
import { sendTelegramMessage, telegramBroadcastAllowed, telegramToken } from "./telegram.js";

export interface BroadcastOptions {
  /** Override targets; defaults to the channel's broadcastChatIds. */
  targets?: string[];
  /** Injectable Telegram sender (tests MUST inject a mock — never send for real). */
  sendTelegram?: typeof sendTelegramMessage;
  /** Console sink for console channels; false silences it. */
  writeConsole?: ((text: string) => void) | false;
}

function broadcastId(): string {
  return `bcast_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Extract the Telegram message_id from a sendMessage response body. */
export function telegramMessageId(body: unknown): string | undefined {
  if (body && typeof body === "object" && "result" in body) {
    const result = (body as { result?: unknown }).result;
    if (result && typeof result === "object" && "message_id" in result) {
      const id = (result as { message_id?: unknown }).message_id;
      if (typeof id === "number" || typeof id === "string") return String(id);
    }
  }
  return undefined;
}

function summarize(
  id: string,
  channel: ChannelConfig,
  text: string,
  requestedAt: string,
  posts: BroadcastPost[],
): BroadcastResult {
  return {
    id,
    channelId: channel.id,
    channelKind: channel.kind,
    text,
    requestedAt,
    total: posts.length,
    sent: posts.filter((p) => p.status === "sent").length,
    failed: posts.filter((p) => p.status === "failed").length,
    skipped: posts.filter((p) => p.status === "skipped").length,
    posts,
  };
}

async function broadcastTelegram(
  channel: TelegramChannelConfig,
  text: string,
  options: BroadcastOptions,
): Promise<BroadcastPost[]> {
  const send = options.sendTelegram || sendTelegramMessage;
  const targets = options.targets ?? channel.broadcastChatIds ?? [];
  if (!targets.length) {
    throw new Error(
      `Telegram channel ${channel.id} has no broadcast targets: configure broadcastChatIds or pass explicit targets`,
    );
  }

  const posts: BroadcastPost[] = [];
  for (const target of targets) {
    if (!telegramBroadcastAllowed(channel, target)) {
      posts.push({ target, status: "skipped", detail: "chat id not in outbound broadcast allowlist" });
      continue;
    }
    try {
      const body = await send(telegramToken(channel), target, text);
      posts.push({ target, status: "sent", messageId: telegramMessageId(body), sentAt: new Date().toISOString() });
    } catch (err) {
      posts.push({ target, status: "failed", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return posts;
}

/**
 * Broadcast a message to every configured target of a channel.
 * Returns per-post delivery status; never throws on individual post failures.
 */
export async function broadcast(
  config: BridgeConfig,
  channelRef: string,
  message: string,
  options: BroadcastOptions = {},
): Promise<BroadcastResult> {
  const channel = config.channels[channelRef];
  if (!channel) throw new Error(`Unknown channel: ${channelRef}`);
  if (channel.enabled === false) throw new Error(`Channel ${channelRef} is disabled`);
  if (!message.trim()) throw new Error("Broadcast message must not be empty");

  const id = broadcastId();
  const requestedAt = new Date().toISOString();

  if (channel.kind === "telegram") {
    const posts = await broadcastTelegram(channel, message, options);
    return summarize(id, channel, message, requestedAt, posts);
  }

  if (channel.kind === "console") {
    const posts: BroadcastPost[] = [];
    if (options.writeConsole === false) {
      posts.push({ target: "console", status: "skipped", detail: "console output disabled" });
    } else {
      (options.writeConsole || console.log)(message);
      posts.push({ target: "console", status: "sent", sentAt: new Date().toISOString() });
    }
    return summarize(id, channel, message, requestedAt, posts);
  }

  throw new Error(`Channel kind ${channel.kind} does not support broadcast`);
}

const BROADCAST_HISTORY_LIMIT = 200;

/** Persist a broadcast delivery report in state (keeps the most recent 200). */
export function recordBroadcast(state: BridgeState, result: BroadcastResult): void {
  const broadcasts = state.broadcasts ?? {};
  broadcasts[result.id] = result;
  const ids = Object.keys(broadcasts).sort(
    (a, b) => (broadcasts[a]!.requestedAt < broadcasts[b]!.requestedAt ? -1 : 1),
  );
  while (ids.length > BROADCAST_HISTORY_LIMIT) {
    const oldest = ids.shift();
    if (oldest) delete broadcasts[oldest];
  }
  state.broadcasts = broadcasts;
}

/** List recorded broadcast reports, most recent first. */
export function listBroadcasts(state: BridgeState, options: { limit?: number; channelId?: string } = {}): BroadcastResult[] {
  const all = Object.values(state.broadcasts ?? {})
    .filter((b) => !options.channelId || b.channelId === options.channelId)
    .sort((a, b) => (a.requestedAt > b.requestedAt ? -1 : 1));
  return options.limit ? all.slice(0, options.limit) : all;
}

/** Look up a single broadcast report by id. */
export function getBroadcast(state: BridgeState, id: string): BroadcastResult | undefined {
  return (state.broadcasts ?? {})[id];
}
