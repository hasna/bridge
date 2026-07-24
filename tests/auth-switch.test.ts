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

const SID_A = "aaaaaaaa-1111-2222-3333-444444444444";
const SID_B = "bbbbbbbb-2222-3333-4444-555555555555";

function state(): BridgeState {
  return { schemaVersion: 2, telegramOffsets: {}, sessions: {}, bindings: {}, messageLedger: {}, cursors: {} };
}

/** The codewith auth profile (billing account) selected via the native flag. */
function authProfileOf(command: string[]): string | undefined {
  const i = command.indexOf("--auth-profile");
  return i >= 0 ? command[i + 1] : undefined;
}

/** The thread id a `resume` argv is resuming, if any. */
function resumedId(command: string[]): string | undefined {
  const i = command.indexOf("resume");
  return i >= 0 ? command[i + 1] : undefined;
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
    const account = authProfileOf(command);
    const outFile = command[command.indexOf("-o") + 1]!;
    if (account === "account088") {
      // Primary billing account is exhausted.
      return { exitCode: 1, stdout: '{"type":"error","message":"rate limit exceeded (429)"}', stderr: "usage limit reached", timedOut: false };
    }
    // Fallback account succeeds.
    outputs.set(outFile, "reply from B");
    return {
      exitCode: 0,
      stdout: `{"type":"thread.started","thread_id":"${SID_B}"}\n{"type":"agent_message","role":"assistant","text":"noise"}`,
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

  // First-ever turn rotated to the backup account. There was no prior thread to
  // carry, so a fresh one is created — but this is NOT a "context reset" of an
  // existing conversation, so no misleading note is shown.
  expect(sentText).toContain("reply from B");
  expect(sentText).not.toContain(CONTEXT_RESET_NOTE);
  const binding = bridgeState.bindings["tg::telegram:tg:1"];
  const session = bridgeState.sessions[binding!.activeSessionId];
  expect(session.agentSession?.authProfile).toBe("account001");
  // One shared thread id, now billed to the backup account.
  expect(session.agentSession?.refId).toBe(SID_B);

  // The next message must now start on the fallback account and resume the thread.
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

test("mid-conversation rotation resumes the SAME thread under the backup account (context carries, no reset note)", async () => {
  // The headline guarantee: a conversation established under account A, then hit
  // by exhaustion mid-stream, continues on account B by RESUMING the very same
  // codewith thread id — so earlier context is preserved and no misleading
  // "context was reset" note is shown.
  process.env["TG_TOKEN"] = "test-token";
  const bridgeState = state();
  const outputs = new Map<string, string>();
  const seen: string[][] = [];
  let primaryExhausted = false;

  const spawn: AgentSpawn = async (command) => {
    seen.push(command);
    const account = authProfileOf(command);
    const outFile = command[command.indexOf("-o") + 1]!;
    const resuming = resumedId(command);
    if (account === "account088" && primaryExhausted) {
      return { exitCode: 1, stdout: '{"type":"error","message":"rate limit exceeded (429)"}', stderr: "usage limit reached", timedOut: false };
    }
    // Success. codewith echoes the thread it actually ran: a resumed turn keeps
    // the same id (shared, auth-independent store), a brand-new turn opens SID_A.
    const threadId = resuming ?? SID_A;
    outputs.set(outFile, resuming ? "reply on the resumed thread" : "first reply");
    return { exitCode: 0, stdout: `{"type":"thread.started","thread_id":"${threadId}"}`, stderr: "", timedOut: false };
  };
  const run = (c: BridgeConfig, agentId: string, input: Parameters<typeof runAgent>[2]) =>
    runAgent(c, agentId, input, { spawn, readOutput: async (p) => outputs.get(p) });

  // Turn 1 on the primary account establishes the conversation thread.
  let firstText = "";
  await dispatchMessageWithSessions(config, bridgeState, {
    id: "telegram:1", channelId: "tg", chatId: "1", text: "remember X", receivedAt: new Date(0).toISOString(),
  }, { run, sendTelegram: async (_t, _c, text) => { firstText = text; return { ok: true }; } });

  const binding = bridgeState.bindings["tg::telegram:tg:1"];
  const session = bridgeState.sessions[binding!.activeSessionId];
  expect(session.agentSession?.refId).toBe(SID_A);
  expect(session.agentSession?.authProfile).toBe("account088");
  expect(firstText).not.toContain(CONTEXT_RESET_NOTE);

  // Turn 2: the primary account is now exhausted mid-conversation.
  primaryExhausted = true;
  seen.length = 0;
  let secondText = "";
  await dispatchMessageWithSessions(config, bridgeState, {
    id: "telegram:2", channelId: "tg", chatId: "1", text: "what did I say?", receivedAt: new Date(0).toISOString(),
  }, { run, sendTelegram: async (_t, _c, text) => { secondText = text; return { ok: true }; } });

  // Two spawns this turn: exhausted primary, then the backup account.
  expect(seen.length).toBe(2);
  expect(authProfileOf(seen[0]!)).toBe("account088");
  const backup = seen[1]!;
  expect(authProfileOf(backup)).toBe("account001");
  // The billing account changed BUT the backup RESUMED the SAME thread id — this
  // is the proof that context carried across the switch.
  expect(backup).toContain("resume");
  expect(resumedId(backup)).toBe(SID_A);
  // The conversation is still pinned to the same thread, now billed to the backup.
  expect(session.agentSession?.refId).toBe(SID_A);
  expect(session.agentSession?.authProfile).toBe("account001");
  // Context preserved -> no misleading reset note; the reply came off the thread.
  expect(secondText).not.toContain(CONTEXT_RESET_NOTE);
  expect(secondText).toContain("reply on the resumed thread");
});
