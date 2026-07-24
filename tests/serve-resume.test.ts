import { expect, test } from "bun:test";
import {
  attachBridgeSession,
  createBridgeSession,
  handleInboundMessage,
  reconcileInFlight,
  DEFAULT_MAX_ATTEMPTS,
  type AgentRunResult,
  type BridgeConfig,
  type BridgeState,
} from "../src/index.js";

const config: BridgeConfig = {
  version: 1,
  channels: {
    local: { id: "local", kind: "console", enabled: true },
  },
  profiles: {},
  agents: {
    echo: { id: "echo", kind: "shell", command: "printf", args: ["ok:{prompt}"] },
  },
  routes: [],
};

function boundState(): BridgeState {
  const state: BridgeState = {
    schemaVersion: 2, telegramOffsets: {}, sessions: {}, bindings: {}, messageLedger: {}, cursors: {},
  };
  const session = createBridgeSession(config, state, { id: "ses_test", agentId: "echo" });
  attachBridgeSession(config, state, { sessionId: session.id, channelId: "local", conversation: "thread" });
  return state;
}

const message = {
  id: "msg-1", channelId: "local", chatId: "thread", text: "hi", receivedAt: new Date(0).toISOString(),
};

test("DEFAULT_MAX_ATTEMPTS is a sane positive cap", () => {
  expect(DEFAULT_MAX_ATTEMPTS).toBeGreaterThan(0);
});

test("a delivered message advances the offset", async () => {
  const state = boundState();
  const outcome = await handleInboundMessage(config, state, message, {
    writeConsole: false,
    run: async (_c, agentId): Promise<AgentRunResult> => ({
      agentId, command: ["fake"], exitCode: 0, stdout: "ok", stderr: "", timedOut: false,
    }),
  });
  expect(outcome.advanceOffset).toBe(true);
  expect(outcome.ledgerStatus).toBe("delivered");
});

test("replaying an already-delivered message advances without re-running the agent", async () => {
  const state = boundState();
  let calls = 0;
  const run = async (_c: BridgeConfig, agentId: string): Promise<AgentRunResult> => {
    calls++;
    return { agentId, command: ["fake"], exitCode: 0, stdout: "ok", stderr: "", timedOut: false };
  };
  const first = await handleInboundMessage(config, state, message, { writeConsole: false, run });
  const replay = await handleInboundMessage(config, state, message, { writeConsole: false, run });

  expect(first.advanceOffset).toBe(true);
  expect(replay.advanceOffset).toBe(true);
  expect(replay.ledgerStatus).toBe("delivered");
  expect(calls).toBe(1); // no duplicate execution on replay from a persisted offset
});

test("a poison message does not advance until the attempt cap, then dead-letters", async () => {
  const state = boundState();
  let calls = 0;
  const deadLettered: string[] = [];
  const run = async (_c: BridgeConfig, agentId: string): Promise<AgentRunResult> => {
    calls++;
    return { agentId, command: ["fake"], exitCode: 2, stdout: "", stderr: "boom", timedOut: false };
  };
  const opts = {
    writeConsole: false as const,
    maxAttempts: 3,
    run,
    onDeadLetter: (m: { id: string }) => { deadLettered.push(m.id); },
  };

  const a1 = await handleInboundMessage(config, state, message, opts);
  const a2 = await handleInboundMessage(config, state, message, opts);
  const a3 = await handleInboundMessage(config, state, message, opts);

  // Attempts 1 and 2: retryable, offset must stay put so nothing newer is lost.
  expect(a1.advanceOffset).toBe(false);
  expect(a2.advanceOffset).toBe(false);
  // Attempt 3 hits the cap: dead-letter and unblock the queue.
  expect(a3.advanceOffset).toBe(true);
  expect(a3.deadLettered).toBe(true);
  expect(a3.ledgerStatus).toBe("dead_letter");
  expect(deadLettered).toEqual([message.id]);
  expect(calls).toBe(3);

  // A dead-lettered message is terminal: re-seeing it advances without re-running.
  const replay = await handleInboundMessage(config, state, message, opts);
  expect(replay.advanceOffset).toBe(true);
  expect(calls).toBe(3);
});

test("reconcileInFlight reports in-flight ledger entries and clears stale processing errors", () => {
  const state = boundState();
  state.messageLedger["local::a"] = {
    id: "local::a", channelId: "local", messageId: "a", status: "processing",
    attempts: 1, firstSeenAt: "", updatedAt: "", error: "stale crash",
  };
  state.messageLedger["local::b"] = {
    id: "local::b", channelId: "local", messageId: "b", status: "agent_completed",
    attempts: 1, firstSeenAt: "", updatedAt: "", responseText: "stored",
  };
  state.messageLedger["local::c"] = {
    id: "local::c", channelId: "local", messageId: "c", status: "failed",
    attempts: 2, firstSeenAt: "", updatedAt: "",
  };
  state.telegramOffsets["tg"] = 42;

  const report = reconcileInFlight(state);
  expect(report.processing).toEqual(["local::a"]);
  expect(report.agentCompleted).toEqual(["local::b"]);
  expect(report.failed).toEqual(["local::c"]);
  expect(report.sessions).toBe(1);
  expect(report.bindings).toBe(1);
  expect(report.offsets).toEqual({ tg: 42 });
  // Stale error on the interrupted processing entry is cleared for a clean retry.
  expect(state.messageLedger["local::a"].error).toBeUndefined();
});
