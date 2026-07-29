import { expect, test } from "bun:test";
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_DELIVERY_ATTEMPTS,
  handleInboundMessage,
  ledgerId,
  type AgentRunResult,
  type BridgeConfig,
  type BridgeMessage,
  type BridgeState,
  type MessageLedgerEntry,
} from "../src/index.js";

process.env["DELIVERY_TG_TOKEN"] = "test-token";

function config(): BridgeConfig {
  return {
    version: 1,
    channels: {
      tg: {
        id: "tg", kind: "telegram", enabled: true, botTokenEnv: "DELIVERY_TG_TOKEN",
        allowedChatIds: ["1"], defaultAgentId: "echo",
      },
    },
    profiles: {},
    agents: { echo: { id: "echo", kind: "shell", command: "printf", args: ["ok"] } },
    routes: [],
  };
}

function state(): BridgeState {
  return { schemaVersion: 2, telegramOffsets: {}, sessions: {}, bindings: {}, messageLedger: {}, cursors: {} };
}

function message(): BridgeMessage {
  return {
    id: "telegram:900",
    channelId: "tg",
    chatId: "1",
    text: "what is the answer",
    receivedAt: new Date(0).toISOString(),
  };
}

/**
 * An agent that answers successfully, plus a transport that can be switched
 * between failing and working. Tracks how often the agent actually ran, so a
 * redelivery that silently re-does the work is detectable.
 */
function harness() {
  let agentRuns = 0;
  let transportUp = false;
  const sent: string[] = [];
  const deadLettered: MessageLedgerEntry[] = [];
  const deliveryExhausted: MessageLedgerEntry[] = [];
  return {
    get agentRuns() { return agentRuns; },
    get sent() { return sent; },
    get deadLettered() { return deadLettered; },
    get deliveryExhausted() { return deliveryExhausted; },
    bringTransportUp() { transportUp = true; },
    options: {
      run: async (_config: BridgeConfig, agentId: string): Promise<AgentRunResult> => {
        agentRuns += 1;
        return { agentId, command: ["fake"], exitCode: 0, stdout: "the answer is 42", stderr: "", timedOut: false };
      },
      sendTelegram: async (_token: string, _chatId: string, text: string) => {
        if (!transportUp) throw new Error("Telegram sendMessage failed (502): Bad Gateway");
        sent.push(text);
        return { ok: true };
      },
      onDeadLetter: (_msg: BridgeMessage, entry: MessageLedgerEntry) => { deadLettered.push(entry); },
      onDeliveryExhausted: (_msg: BridgeMessage, entry: MessageLedgerEntry) => { deliveryExhausted.push(entry); },
    },
  };
}

test("a transport failure delivering a completed reply is not a processing failure", async () => {
  const cfg = config();
  const bridgeState = state();
  const h = harness();

  // Enough attempts to blow well past the agent-attempt budget.
  for (let attempt = 0; attempt < DEFAULT_MAX_ATTEMPTS + 2; attempt++) {
    const outcome = await handleInboundMessage(cfg, bridgeState, message(), h.options);
    expect(outcome.deadLettered).toBe(false);
    expect(outcome.ledgerStatus).toBe("agent_completed");
    expect(outcome.advanceOffset).toBe(false);
  }

  // The agent produced the answer once; redelivery must not re-run it.
  expect(h.agentRuns).toBe(1);
  // The user was never told the message could not be processed.
  expect(h.deadLettered).toEqual([]);

  const entry = bridgeState.messageLedger[ledgerId(message())]!;
  expect(entry.status).toBe("agent_completed");
  expect(entry.responseText).toBe("the answer is 42");
  expect(entry.deliveryAttempts).toBe(DEFAULT_MAX_ATTEMPTS + 2);
});

test("the already-produced reply survives the transport outage and is delivered on recovery", async () => {
  const cfg = config();
  const bridgeState = state();
  const h = harness();

  for (let attempt = 0; attempt < 3; attempt++) {
    await handleInboundMessage(cfg, bridgeState, message(), h.options);
  }
  h.bringTransportUp();

  const outcome = await handleInboundMessage(cfg, bridgeState, message(), h.options);
  expect(outcome.advanceOffset).toBe(true);
  expect(outcome.ledgerStatus).toBe("delivered");
  expect(h.sent).toEqual(["the answer is 42"]);
  // Still exactly one agent run across the whole outage.
  expect(h.agentRuns).toBe(1);
});

test("an exhausted delivery budget unblocks the queue without claiming a processing failure", async () => {
  const cfg = config();
  const bridgeState = state();
  const h = harness();

  let final = await handleInboundMessage(cfg, bridgeState, message(), h.options);
  for (let attempt = 1; attempt < DEFAULT_MAX_DELIVERY_ATTEMPTS; attempt++) {
    expect(final.advanceOffset).toBe(false);
    final = await handleInboundMessage(cfg, bridgeState, message(), h.options);
  }

  // The queue must not stay head-of-line blocked forever on one undeliverable chat.
  expect(final.advanceOffset).toBe(true);
  expect(final.deliveryExhausted).toBe(true);
  expect(final.deadLettered).toBe(false);
  expect(h.deadLettered).toEqual([]);
  expect(h.deliveryExhausted).toHaveLength(1);

  // The answer is retained, not discarded: the entry stays non-terminal so a
  // replay redelivers the stored reply instead of re-running the agent.
  const entry = bridgeState.messageLedger[ledgerId(message())]!;
  expect(entry.status).toBe("agent_completed");
  expect(entry.responseText).toBe("the answer is 42");
  expect(entry.error).toContain("502");
});

test("an agent that never succeeds is still dead-lettered on the agent budget", async () => {
  const cfg = config();
  const bridgeState = state();
  const deadLettered: MessageLedgerEntry[] = [];
  const options = {
    run: async (): Promise<AgentRunResult> => ({
      agentId: "echo", command: ["fake"], exitCode: 1, stdout: "", stderr: "boom", timedOut: false,
    }),
    sendTelegram: async () => ({ ok: true }),
    onDeadLetter: (_msg: BridgeMessage, entry: MessageLedgerEntry) => { deadLettered.push(entry); },
  };

  let outcome = await handleInboundMessage(cfg, bridgeState, message(), options);
  for (let attempt = 1; attempt < DEFAULT_MAX_ATTEMPTS; attempt++) {
    expect(outcome.deadLettered).toBe(false);
    outcome = await handleInboundMessage(cfg, bridgeState, message(), options);
  }

  expect(outcome.deadLettered).toBe(true);
  expect(outcome.ledgerStatus).toBe("dead_letter");
  expect(outcome.advanceOffset).toBe(true);
  expect(deadLettered).toHaveLength(1);
});
