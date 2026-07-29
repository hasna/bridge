import type { BridgeConfig, BridgeMessage, MessageLedgerEntry, TelegramChannelConfig } from "../types.js";
import type { BridgeState } from "./state.js";
import {
  dispatchMessageWithSessions,
  isTerminalLedgerStatus,
  ledgerId,
  type DispatchMessageResult,
  type SessionMessageOptions,
} from "./sessions.js";

/**
 * How many times a single inbound message may be attempted before it is moved to
 * the dead-letter state. Without a cap, a message whose agent keeps failing would
 * block the poll offset forever (head-of-line poisoning) and no newer message
 * could ever be processed.
 */
export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * How many times an already-produced reply may be re-sent before the poll cursor
 * moves on. Deliberately larger and separate from {@link DEFAULT_MAX_ATTEMPTS}:
 * redelivery is cheap (the agent is not re-run, the stored reply is re-sent) and
 * transport outages are usually transient, so it is worth trying much harder
 * before giving up on an answer that already exists.
 */
export const DEFAULT_MAX_DELIVERY_ATTEMPTS = 10;

export interface MissingTelegramToken {
  channelId: string;
  envVar: string;
}

/**
 * Enabled Telegram channels whose bot-token env var is not set in this process.
 *
 * A missing token is a configuration error, not a transient one: the poller can
 * never recover from it because the environment is fixed at spawn time. Callers
 * use this to fail fast with an actionable message instead of retrying forever.
 */
export function missingTelegramTokenEnvVars(config: BridgeConfig): MissingTelegramToken[] {
  return Object.values(config.channels)
    .filter((channel): channel is TelegramChannelConfig => channel.kind === "telegram" && channel.enabled !== false)
    .map((channel) => ({ channelId: channel.id, envVar: channel.botTokenEnv || "TELEGRAM_BOT_TOKEN" }))
    .filter((item) => !process.env[item.envVar]);
}

/** Throws one clear error naming every channel and env var that must be set. */
export function assertTelegramTokensConfigured(config: BridgeConfig): void {
  const missing = missingTelegramTokenEnvVars(config);
  if (!missing.length) return;
  const lines = missing.map((item) => `  ${item.channelId}: set ${item.envVar}`);
  throw new Error(
    `Missing Telegram bot token${missing.length === 1 ? "" : "s"} for ${missing.length} enabled channel${missing.length === 1 ? "" : "s"}:\n`
    + `${lines.join("\n")}\n`
    + "Export the variable(s) in the environment that runs bridge, or disable the channel(s).",
  );
}

export interface PollBackoffInput {
  /** Consecutive failures for this channel, starting at 1. */
  attempt: number;
  /** Configured poll interval, used as the linear backoff step. */
  intervalMs: number;
  /** Telegram's 429 `retry_after`, when the provider told us how long to wait. */
  retryAfterSeconds?: number;
}

export const MIN_POLL_BACKOFF_MS = 1000;
export const MAX_POLL_BACKOFF_MS = 30_000;
export const MAX_RETRY_AFTER_BACKOFF_MS = 300_000;

/**
 * Backoff for a failed poll. When Telegram answers 429 with `retry_after` we
 * honour it — retrying sooner is what escalates a soft rate limit into a longer
 * one — otherwise we step linearly up to a 30s ceiling.
 */
export function pollBackoffMs(input: PollBackoffInput): number {
  if (input.retryAfterSeconds !== undefined && Number.isFinite(input.retryAfterSeconds)) {
    return Math.min(MAX_RETRY_AFTER_BACKOFF_MS, Math.max(MIN_POLL_BACKOFF_MS, input.retryAfterSeconds * 1000));
  }
  const attempt = Math.min(Math.max(1, input.attempt), 30);
  return Math.min(MAX_POLL_BACKOFF_MS, Math.max(MIN_POLL_BACKOFF_MS, input.intervalMs * attempt));
}

export interface HandleInboundOptions extends SessionMessageOptions {
  /** Cap on attempts at *processing* the message (running the agent). */
  maxAttempts?: number;
  /** Cap on attempts at *delivering* a reply the agent already produced. */
  maxDeliveryAttempts?: number;
  /** Invoked when a message is moved to dead-letter, e.g. to notify the sender. */
  onDeadLetter?: (message: BridgeMessage, entry: MessageLedgerEntry) => Promise<void> | void;
  /**
   * Invoked when a reply the agent already produced could not be delivered
   * within the delivery budget. The reply stays in the ledger; this is an
   * operator signal, NOT a message to the sender — the transport to them is
   * exactly what is broken.
   */
  onDeliveryExhausted?: (message: BridgeMessage, entry: MessageLedgerEntry) => Promise<void> | void;
}

export interface InboundOutcome {
  ledgerStatus: MessageLedgerEntry["status"];
  /** True when the poll cursor/offset may advance past this message. */
  advanceOffset: boolean;
  deadLettered: boolean;
  /**
   * True when an already-produced reply hit the delivery budget. The message was
   * processed successfully; only the send failed, so this is never a dead-letter.
   */
  deliveryExhausted: boolean;
  result: DispatchMessageResult;
  error?: string;
}

function markDeadLetter(entry: MessageLedgerEntry, error: string): void {
  const timestamp = new Date().toISOString();
  entry.status = "dead_letter";
  entry.error = error;
  entry.updatedAt = timestamp;
  entry.terminalAt = timestamp;
}

/**
 * Dispatches one inbound message and decides whether the poll offset may advance.
 *
 * - Terminal outcome (delivered/skipped/unauthorized/dead_letter) -> advance.
 * - Retryable failure with attempts under the cap -> do NOT advance; the same
 *   update is re-polled next iteration and retried (offset stays put, so nothing
 *   is lost).
 * - Retryable failure at/over the cap -> dead-letter and advance, so a poison
 *   message cannot block every newer update behind it.
 *
 * PROCESSING and DELIVERY failures are accounted separately. Once the ledger
 * reaches `agent_completed` the agent has produced an answer and it is stored in
 * `entry.responseText`; a later failure is a transport problem. Charging that to
 * the processing budget dead-lettered fully answered messages and told the sender
 * "I could not process that message" — wrong, and it discarded a real answer. A
 * delivery failure therefore consumes {@link MessageLedgerEntry.deliveryAttempts}
 * against `maxDeliveryAttempts`, never dead-letters, and leaves the entry
 * non-terminal so the stored reply is redelivered rather than recomputed.
 *
 * Idempotency is inherited from the message ledger: an already-terminal message
 * short-circuits without re-invoking the agent, so replaying from a persisted
 * offset never duplicates work.
 */
export async function handleInboundMessage(
  config: BridgeConfig,
  state: BridgeState,
  message: BridgeMessage,
  options: HandleInboundOptions = {},
): Promise<InboundOutcome> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const maxDeliveryAttempts = Math.max(1, options.maxDeliveryAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS);
  try {
    const result = await dispatchMessageWithSessions(config, state, message, options);
    const status = result.ledger?.status ?? "processing";
    if (isTerminalLedgerStatus(status)) {
      return { ledgerStatus: status, advanceOffset: true, deadLettered: false, deliveryExhausted: false, result };
    }
    // Non-terminal (processing/agent_completed): interrupted before delivery.
    return {
      ledgerStatus: status,
      advanceOffset: false,
      deadLettered: false,
      deliveryExhausted: false,
      result,
      error: result.ledger?.error,
    };
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    const entry = state.messageLedger[ledgerId(message)];

    // The agent already answered: this is a delivery failure, on its own budget.
    if (entry?.status === "agent_completed") {
      entry.deliveryAttempts = (entry.deliveryAttempts ?? 0) + 1;
      entry.error = errorText;
      entry.updatedAt = new Date().toISOString();
      if (entry.deliveryAttempts >= maxDeliveryAttempts) {
        // Advance so one undeliverable conversation cannot block every newer
        // message, but keep the entry non-terminal with its responseText intact:
        // the answer is retained and redeliverable, never dead-lettered, and the
        // sender is not told their message failed to process.
        await options.onDeliveryExhausted?.(message, entry);
        return {
          ledgerStatus: entry.status,
          advanceOffset: true,
          deadLettered: false,
          deliveryExhausted: true,
          result: { message, ledger: entry },
          error: errorText,
        };
      }
      return {
        ledgerStatus: entry.status,
        advanceOffset: false,
        deadLettered: false,
        deliveryExhausted: false,
        result: { message, ledger: entry },
        error: errorText,
      };
    }

    const attempts = entry?.attempts ?? 1;
    if (entry && attempts >= maxAttempts) {
      markDeadLetter(entry, errorText);
      await options.onDeadLetter?.(message, entry);
      return {
        ledgerStatus: "dead_letter",
        advanceOffset: true,
        deadLettered: true,
        deliveryExhausted: false,
        result: { message, ledger: entry },
        error: errorText,
      };
    }
    return {
      ledgerStatus: entry?.status ?? "failed",
      advanceOffset: false,
      deadLettered: false,
      deliveryExhausted: false,
      result: { message, ledger: entry ?? undefined },
      error: errorText,
    };
  }
}

export interface ResumeReport {
  processing: string[];
  agentCompleted: string[];
  failed: string[];
  bindings: number;
  sessions: number;
  offsets: Record<string, number>;
}

/**
 * Reconciles durable state on resume. Bindings, sessions and the getUpdates
 * offset are already persisted and reloaded every poll, so "reattach" means:
 * surface the in-flight work (interrupted `processing` / undelivered
 * `agent_completed` / `failed` ledger entries) that will be retried or
 * redelivered, and reset stale `processing` entries so they are reprocessed
 * cleanly on the next poll. Returns a report for observability.
 */
export function reconcileInFlight(state: BridgeState): ResumeReport {
  const report: ResumeReport = {
    processing: [],
    agentCompleted: [],
    failed: [],
    bindings: Object.keys(state.bindings).length,
    sessions: Object.keys(state.sessions).length,
    offsets: { ...state.telegramOffsets },
  };
  for (const entry of Object.values(state.messageLedger)) {
    if (entry.status === "processing") {
      report.processing.push(entry.id);
      // Interrupted mid-run: clear stale error so the retry starts fresh.
      delete entry.error;
    } else if (entry.status === "agent_completed") {
      report.agentCompleted.push(entry.id);
    } else if (entry.status === "failed") {
      report.failed.push(entry.id);
    }
  }
  return report;
}
