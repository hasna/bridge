import { expect, test } from "bun:test";
import {
  extractCodewithSessionId,
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

const OLD_SID = "aaaaaaaa-1111-2222-3333-444444444444";
const NEW_SID = "cccccccc-9999-8888-7777-666666666666";
const message = { id: "m", channelId: "tg", text: "hi", receivedAt: new Date(0).toISOString() };
const route = { id: "r", fromChannel: "tg", toAgent: "cw" };

function durableSession(providerSessions: Record<string, string>): BridgeSession {
  return {
    id: "s", agentId: "cw", status: "active", createdAt: "", updatedAt: "",
    agentSession: { kind: "codewith", mode: "durable", authProfile: "account088", providerSessions },
  } as unknown as BridgeSession;
}

test("extractCodewithSessionId reads thread_id from the canonical thread.started event", () => {
  const jsonl = [
    '{"type":"thread.started","thread_id":"' + NEW_SID + '"}',
    '{"type":"agent_message","role":"assistant","text":"hi"}',
  ].join("\n");
  expect(extractCodewithSessionId(jsonl)).toBe(NEW_SID);
});

test("extractCodewithSessionId prefers the session-start event over an unrelated echoed id", () => {
  // A tool-call event echoes some other id first; the real session id comes from
  // the thread.started event and must win.
  const jsonl = [
    '{"type":"tool_call","conversation_id":"not-the-session"}',
    '{"type":"thread.started","thread_id":"' + NEW_SID + '"}',
  ].join("\n");
  expect(extractCodewithSessionId(jsonl)).toBe(NEW_SID);
});

test("runAgent self-heals a stale resumed session by retrying with a fresh session", async () => {
  const seen: string[][] = [];
  const spawn: AgentSpawn = async (command) => {
    seen.push(command);
    const resuming = command.includes("resume");
    if (resuming) {
      // The stored session id is gone on the provider side.
      return { exitCode: 1, stdout: '{"type":"error","error":{"type":"session_not_found","message":"no such session"}}', stderr: "", timedOut: false };
    }
    // Fresh session succeeds and yields a new id.
    return { exitCode: 0, stdout: '{"type":"thread.started","thread_id":"' + NEW_SID + '"}', stderr: "", timedOut: false };
  };
  const result = await runAgent(config, "cw", { message, route, session: durableSession({ account088: OLD_SID }) }, {
    spawn, readOutput: async () => "fresh reply",
  });

  expect(result.exitCode).toBe(0);
  expect(result.staleSessionHealed).toBe(true);
  expect(result.contextReset).toBe(true);
  expect(result.replyText).toBe("fresh reply");
  expect(result.providerSessionId).toBe(NEW_SID);
  // Two spawns on the SAME (primary) profile: stale resume, then fresh retry.
  expect(seen.length).toBe(2);
  expect(seen[0]).toContain("resume");
  expect(seen[0]).toContain(OLD_SID);
  expect(seen[1]).not.toContain("resume");
  expect(seen[1]).toContain("account088");
});

test("runAgent does not retry-fresh when the resumed session simply errors for another reason", async () => {
  let calls = 0;
  const spawn: AgentSpawn = async () => {
    calls++;
    return { exitCode: 1, stdout: '{"type":"error","error":{"type":"internal_error","message":"boom"}}', stderr: "", timedOut: false };
  };
  const result = await runAgent(config, "cw", { message, route, session: durableSession({ account088: OLD_SID }) }, {
    spawn, readOutput: async () => undefined,
  });
  expect(result.staleSessionHealed).toBeUndefined();
  // A non-stale, non-exhaustion error neither triggers a fresh-retry on the same
  // profile nor rotates: exactly one spawn.
  expect(calls).toBe(1);
});

test("checkUsageExhausted skips a profile known to be out of usage before spawning it", async () => {
  const seen: string[][] = [];
  const spawn: AgentSpawn = async (command) => {
    seen.push(command);
    return { exitCode: 0, stdout: '{"type":"thread.started","thread_id":"' + NEW_SID + '"}', stderr: "", timedOut: false };
  };
  const result = await runAgent(config, "cw", { message, route }, {
    spawn,
    readOutput: async () => "ok",
    // Primary profile is already known-exhausted per the usage probe.
    checkUsageExhausted: (authProfile) => authProfile === "account088",
  });
  // Primary was skipped without spawning; only the healthy fallback ran.
  expect(seen.length).toBe(1);
  expect(seen[0]).toContain("account001");
  expect(result.authProfile).toBe("account001");
  expect(result.rotated).toBe(true);
});
