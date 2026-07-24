import type { BridgeConfig, BridgeMessage, MessageLedgerEntry } from "../types.js";
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

export interface HandleInboundOptions extends SessionMessageOptions {
  maxAttempts?: number;
  /** Invoked when a message is moved to dead-letter, e.g. to notify the sender. */
  onDeadLetter?: (message: BridgeMessage, entry: MessageLedgerEntry) => Promise<void> | void;
}

export interface InboundOutcome {
  ledgerStatus: MessageLedgerEntry["status"];
  /** True when the poll cursor/offset may advance past this message. */
  advanceOffset: boolean;
  deadLettered: boolean;
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
  try {
    const result = await dispatchMessageWithSessions(config, state, message, options);
    const status = result.ledger?.status ?? "processing";
    if (isTerminalLedgerStatus(status)) {
      return { ledgerStatus: status, advanceOffset: true, deadLettered: false, result };
    }
    // Non-terminal (processing/agent_completed): interrupted before delivery.
    return {
      ledgerStatus: status,
      advanceOffset: false,
      deadLettered: false,
      result,
      error: result.ledger?.error,
    };
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    const entry = state.messageLedger[ledgerId(message)];
    const attempts = entry?.attempts ?? 1;
    if (entry && attempts >= maxAttempts) {
      markDeadLetter(entry, errorText);
      await options.onDeadLetter?.(message, entry);
      return {
        ledgerStatus: "dead_letter",
        advanceOffset: true,
        deadLettered: true,
        result: { message, ledger: entry },
        error: errorText,
      };
    }
    return {
      ledgerStatus: entry?.status ?? "failed",
      advanceOffset: false,
      deadLettered: false,
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
