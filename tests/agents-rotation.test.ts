import { expect, test } from "bun:test";
import {
  recordDurableSession,
  runAgent,
  type AgentSpawn,
  type BridgeConfig,
  type BridgeSession,
} from "../src/index.js";

const config: BridgeConfig = {
  version: 1,
  channels: {
    tg: { id: "tg", kind: "telegram", enabled: true, botTokenEnv: "TG_TOKEN", allowedChatIds: ["1"], defaultAgentId: "cw" },
  },
  profiles: {
    A: { id: "A", agentKind: "codewith", authProfile: "account088" },
    B: { id: "B", agentKind: "codewith", authProfile: "account001" },
  },
  agents: {
    cw: { id: "cw", kind: "codewith", profileId: "A", fallbackProfileIds: ["B"] },
  },
  routes: [],
};

const DEAD_SID = "aaaaaaaa-1111-2222-3333-444444444444";
const message = { id: "m", channelId: "tg", text: "hi", receivedAt: new Date(0).toISOString() };
const route = { id: "r", fromChannel: "tg", toAgent: "cw" };

function durableSession(refId?: string): BridgeSession {
  return {
    id: "s", agentId: "cw", status: "active", createdAt: "", updatedAt: "",
    agentSession: { kind: "codewith", mode: "durable", authProfile: "account088", refId },
  } as unknown as BridgeSession;
}

const STALE_EVENT = '{"type":"error","error":{"type":"session_not_found","message":"no such session"}}';

/**
 * Regression: a codewith thread that is permanently gone was never unpinned from
 * the bridge session.
 *
 * `recordDurableSession` bailed out whenever the run produced no new provider
 * session id, so after a stale-session self-heal whose fresh retry also failed
 * (or simply emitted no parseable `thread.started`), the DEAD `refId` stayed on
 * the session. Every later message in that conversation then paid the full
 * self-heal cost again — a wasted `codewith exec resume <dead-id>` spawn before
 * every real one — and, whenever the retry did succeed, re-showed the user the
 * "I started a new session" note over and over.
 */
test("a provably gone thread id is cleared from the session instead of being resumed forever", async () => {
  const session = durableSession(DEAD_SID);
  const spawn: AgentSpawn = async (command) => {
    if (command.includes("resume")) {
      return { exitCode: 1, stdout: STALE_EVENT, stderr: "", timedOut: false };
    }
    // The fresh retry fails too (transient provider outage) and yields no id.
    return { exitCode: 1, stdout: '{"type":"error","error":{"message":"upstream unavailable"}}', stderr: "", timedOut: false };
  };

  const result = await runAgent(config, "cw", { message, route, session }, { spawn, readOutput: async () => undefined });
  expect(result.staleSessionHealed).toBe(true);
  expect(result.providerSessionId).toBeUndefined();

  // The dead pointer must be dropped, so the next turn starts clean.
  expect(recordDurableSession(session, result)).toBe(true);
  expect(session.agentSession?.refId).toBeUndefined();
});

/**
 * Regression: `contextReset` was set from `staleSessionHealed` unconditionally,
 * including when the fresh retry ALSO failed. Nothing was healed in that case —
 * no new thread exists and no reply is produced — so flagging a context reset
 * misreports what happened to the conversation.
 */
test("a failed stale-session retry does not claim the conversation context was reset", async () => {
  const spawn: AgentSpawn = async (command) => {
    if (command.includes("resume")) return { exitCode: 1, stdout: STALE_EVENT, stderr: "", timedOut: false };
    return { exitCode: 1, stdout: '{"type":"error","error":{"message":"upstream unavailable"}}', stderr: "", timedOut: false };
  };
  const result = await runAgent(config, "cw", { message, route, session: durableSession(DEAD_SID) }, {
    spawn, readOutput: async () => undefined,
  });
  expect(result.staleSessionHealed).toBe(true);
  expect(result.contextReset).toBeFalsy();
});

/**
 * Regression: the optional usage probe could kill the whole turn.
 *
 * `checkUsageExhausted` is a best-effort optimisation backed by an external CLI
 * (`codewith usage`). Its rejection — CLI missing, network blip, timeout — was
 * awaited unguarded inside the rotation loop, so it propagated out of `runAgent`
 * and failed the user's message even though every billing account was healthy.
 */
test("a throwing usage probe does not fail the turn", async () => {
  const seen: string[][] = [];
  const spawn: AgentSpawn = async (command) => {
    seen.push(command);
    return { exitCode: 0, stdout: '{"type":"thread.started","thread_id":"' + DEAD_SID + '"}', stderr: "", timedOut: false };
  };

  const result = await runAgent(config, "cw", { message, route }, {
    spawn,
    readOutput: async () => "ok",
    checkUsageExhausted: () => {
      throw new Error("codewith: command not found");
    },
  });

  // The probe failure is treated as "unknown", so the primary profile still runs.
  expect(result.exitCode).toBe(0);
  expect(result.replyText).toBe("ok");
  expect(seen.length).toBe(1);
  expect(seen[0]).toContain("account088");
});

test("a usage probe that rejects asynchronously is also non-fatal", async () => {
  const spawn: AgentSpawn = async () => ({
    exitCode: 0, stdout: '{"type":"thread.started","thread_id":"' + DEAD_SID + '"}', stderr: "", timedOut: false,
  });
  const result = await runAgent(config, "cw", { message, route }, {
    spawn,
    readOutput: async () => "ok",
    checkUsageExhausted: async () => Promise.reject(new Error("usage probe timed out")),
  });
  expect(result.exitCode).toBe(0);
  expect(result.authProfile).toBe("account088");
});
