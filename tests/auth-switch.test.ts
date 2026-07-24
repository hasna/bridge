import { expect, test } from "bun:test";
import {
  activeRotationProfile,
  CONTEXT_RESET_NOTE,
  dispatchMessageWithSessions,
  isExhaustionSignal,
  isStaleSessionSignal,
  nextRotationProfile,
  rotationProfiles,
  runAgent,
  type AgentSpawn,
  type BridgeConfig,
  type BridgeSession,
  type BridgeState,
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

const SID_B = "bbbbbbbb-2222-3333-4444-555555555555";

function state(): BridgeState {
  return { schemaVersion: 2, telegramOffsets: {}, sessions: {}, bindings: {}, messageLedger: {}, cursors: {} };
}

test("isExhaustionSignal classifies codewith --json error events, not raw output strings", () => {
  // Real codewith --json error-event shapes.
  expect(isExhaustionSignal({ exitCode: 1, stdout: '{"type":"error","error":{"type":"rate_limit_error","message":"rate limit"}}', stderr: "", timedOut: false })).toBe(true);
  expect(isExhaustionSignal({ exitCode: 1, stdout: '{"type":"turn.failed","error":{"code":"429","message":"Too Many Requests"}}', stderr: "", timedOut: false })).toBe(true);
  expect(isExhaustionSignal({ exitCode: 1, stdout: '{"error":"usage limit reached"}', stderr: "", timedOut: false })).toBe(true);
  expect(isExhaustionSignal({ exitCode: 1, stdout: '{"type":"error","error":{"type":"authentication_error"}}', stderr: "", timedOut: false })).toBe(true);
  // A structured error event on stderr is also classified.
  expect(isExhaustionSignal({ exitCode: 1, stdout: "", stderr: '{"type":"error","error":{"code":"quota_exceeded"}}', timedOut: false })).toBe(true);
  // NOT a brittle raw-string match: the same words in non-error JSON or plain
  // prose (e.g. the assistant discussing rate limits) must not trigger rotation.
  expect(isExhaustionSignal({ exitCode: 1, stdout: '{"type":"agent_message","role":"assistant","text":"the API has a rate limit of 429 rpm"}', stderr: "", timedOut: false })).toBe(false);
  expect(isExhaustionSignal({ exitCode: 1, stdout: "", stderr: "rate limit exceeded", timedOut: false })).toBe(false);
  // Not exhaustion: success, timeout, or an unrelated error event.
  expect(isExhaustionSignal({ exitCode: 0, stdout: '{"type":"error","error":{"type":"rate_limit_error"}}', stderr: "", timedOut: false })).toBe(false);
  expect(isExhaustionSignal({ exitCode: null, stdout: '{"type":"error","error":{"code":"429"}}', stderr: "", timedOut: true })).toBe(false);
  expect(isExhaustionSignal({ exitCode: 1, stdout: '{"type":"error","error":{"type":"file_not_found"}}', stderr: "", timedOut: false })).toBe(false);
});

test("isStaleSessionSignal detects a gone/expired resumed session from json error events", () => {
  expect(isStaleSessionSignal({ exitCode: 1, stdout: '{"type":"error","error":{"message":"session not found"}}', stderr: "", timedOut: false })).toBe(true);
  expect(isStaleSessionSignal({ exitCode: 1, stdout: '{"type":"error","error":{"type":"thread_not_found","message":"no such thread"}}', stderr: "", timedOut: false })).toBe(true);
  expect(isStaleSessionSignal({ exitCode: 1, stdout: '{"type":"error","message":"rollout for this session is gone"}', stderr: "", timedOut: false })).toBe(true);
  // Unrelated errors and non-error events do not qualify.
  expect(isStaleSessionSignal({ exitCode: 1, stdout: '{"type":"error","error":{"type":"rate_limit_error"}}', stderr: "", timedOut: false })).toBe(false);
  expect(isStaleSessionSignal({ exitCode: 0, stdout: '{"type":"error","message":"session not found"}', stderr: "", timedOut: false })).toBe(false);
});

test("rotationProfiles builds an ordered validated pool", () => {
  const pool = rotationProfiles(config, config.agents.cw);
  expect(pool.map((p) => p.id)).toEqual(["A", "B"]);
});

test("rotationProfiles throws on an unknown or mismatched fallback profile", () => {
  const bad: BridgeConfig = { ...config, agents: { cw: { ...config.agents.cw, fallbackProfileIds: ["missing"] } } };
  expect(() => rotationProfiles(bad, bad.agents.cw)).toThrow("unknown profile");
});

test("nextRotationProfile advances and stops at the pool boundary", () => {
  expect(nextRotationProfile(config, config.agents.cw, "account088")?.id).toBe("B");
  expect(nextRotationProfile(config, config.agents.cw, "account001")).toBeUndefined();
});

test("activeRotationProfile follows the session's pinned auth profile", () => {
  const session = { agentSession: { kind: "codewith", mode: "durable", authProfile: "account001" } } as unknown as BridgeSession;
  expect(activeRotationProfile(config, config.agents.cw, session)?.id).toBe("B");
  expect(activeRotationProfile(config, config.agents.cw, undefined)?.id).toBe("A");
});

function rotatingSpawn(outputs: Map<string, string>, seen: string[][]): AgentSpawn {
  return async (command) => {
    seen.push(command);
    const p = command[command.indexOf("-p") + 1];
    const outFile = command[command.indexOf("-o") + 1]!;
    if (p === "account088") {
      // Primary profile is exhausted.
      return { exitCode: 1, stdout: '{"type":"error","message":"rate limit exceeded (429)"}', stderr: "usage limit reached", timedOut: false };
    }
    // Fallback profile succeeds.
    outputs.set(outFile, "reply from B");
    return {
      exitCode: 0,
      stdout: `{"type":"session.created","session_id":"${SID_B}"}\n{"type":"agent_message","role":"assistant","text":"noise"}`,
      stderr: "",
      timedOut: false,
    };
  };
}

test("runAgent rotates to the fallback profile on exhaustion and continues the turn", async () => {
  const outputs = new Map<string, string>();
  const seen: string[][] = [];
  const result = await runAgent(config, "cw", {
    message: { id: "m", channelId: "tg", text: "hi", receivedAt: new Date(0).toISOString() },
    route: { id: "r", fromChannel: "tg", toAgent: "cw" },
  }, { spawn: rotatingSpawn(outputs, seen), readOutput: async (p) => outputs.get(p) });

  expect(result.rotated).toBe(true);
  expect(result.exhausted).toBe(false);
  expect(result.authProfile).toBe("account001");
  expect(result.replyText).toBe("reply from B");
  expect(result.providerSessionId).toBe(SID_B);
  expect(result.exitCode).toBe(0);
  // Two spawns: exhausted primary, then fallback.
  expect(seen.length).toBe(2);
  expect(seen[0]).toContain("account088");
  expect(seen[1]).toContain("account001");
});

test("runAgent surfaces exhaustion when every profile is exhausted", async () => {
  const spawn: AgentSpawn = async () => ({ exitCode: 1, stdout: '{"type":"error","error":{"code":"quota_exceeded"}}', stderr: "", timedOut: false });
  const result = await runAgent(config, "cw", {
    message: { id: "m", channelId: "tg", text: "hi", receivedAt: new Date(0).toISOString() },
    route: { id: "r", fromChannel: "tg", toAgent: "cw" },
  }, { spawn, readOutput: async () => undefined });
  expect(result.exhausted).toBe(true);
  expect(result.exitCode).toBe(1);
  expect(result.rotated).toBe(true); // tried the fallback too
});

test("exhaustion rotation flows through dispatch and pins the session to the new profile", async () => {
  process.env["TG_TOKEN"] = "test-token";
  const bridgeState = state();
  const outputs = new Map<string, string>();
  const seen: string[][] = [];
  const spawn = rotatingSpawn(outputs, seen);
  let sentText = "";

  const run = (c: BridgeConfig, agentId: string, input: Parameters<typeof runAgent>[2]) =>
    runAgent(c, agentId, input, { spawn, readOutput: async (p) => outputs.get(p) });

  await dispatchMessageWithSessions(config, bridgeState, {
    id: "telegram:1", channelId: "tg", chatId: "1", text: "first", receivedAt: new Date(0).toISOString(),
  }, {
    run,
    sendTelegram: async (_t, _c, text) => { sentText = text; return { ok: true }; },
  });

  // Rotation started a fresh session on the backup profile, so the user is told
  // the context reset (no false claim of seamless cross-profile resume).
  expect(sentText).toContain("reply from B");
  expect(sentText).toContain(CONTEXT_RESET_NOTE);
  const binding = bridgeState.bindings["tg::telegram:tg:1"];
  const session = bridgeState.sessions[binding!.activeSessionId];
  expect(session.agentSession?.authProfile).toBe("account001");
  expect(session.agentSession?.providerSessions?.account001).toBe(SID_B);

  // The next message must now start on the fallback profile and resume its session.
  seen.length = 0;
  let secondText = "";
  await dispatchMessageWithSessions(config, bridgeState, {
    id: "telegram:2", channelId: "tg", chatId: "1", text: "second", receivedAt: new Date(0).toISOString(),
  }, {
    run,
    sendTelegram: async (_t, _c, text) => { secondText = text; return { ok: true }; },
  });
  expect(seen.length).toBe(1); // no re-rotation; starts directly on the healthy profile
  expect(seen[0]).toContain("account001");
  expect(seen[0]).toContain("resume");
  expect(seen[0]).toContain(SID_B);
  // No further rotation -> no context-reset note on the follow-up reply.
  expect(secondText).not.toContain(CONTEXT_RESET_NOTE);
});
