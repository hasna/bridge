import { expect, test } from "bun:test";
import {
  buildAccountsCommand,
  buildAgentEnv,
  buildCodewithExecArgs,
  dispatchMessageWithSessions,
  extractCodewithLastMessage,
  extractCodewithSessionId,
  recordDurableSession,
  resolveDurableTarget,
  runAgent,
  type AgentRunResult,
  type AgentSpawn,
  type BridgeConfig,
  type BridgeSession,
  type BridgeState,
} from "../src/index.js";

const config: BridgeConfig = {
  version: 1,
  channels: {
    tg: {
      id: "tg", kind: "telegram", enabled: true, botTokenEnv: "TG_TOKEN",
      allowedChatIds: ["1"], defaultAgentId: "cw",
    },
  },
  profiles: {
    cw: { id: "cw", agentKind: "codewith", authProfile: "account088", cwd: "/repo" },
  },
  agents: {
    cw: { id: "cw", kind: "codewith", profileId: "cw" },
  },
  routes: [],
};

function state(): BridgeState {
  return { schemaVersion: 2, telegramOffsets: {}, sessions: {}, bindings: {}, messageLedger: {}, cursors: {} };
}

const SESSION_UUID = "11111111-2222-3333-4444-555555555555";

test("buildCodewithExecArgs creates a durable json exec with an output file", () => {
  const args = buildCodewithExecArgs({ prompt: "hello", outputFile: "/tmp/o.txt", cwd: "/repo" });
  expect(args).toEqual(["exec", "--json", "--durable", "--skip-git-repo-check", "-o", "/tmp/o.txt", "-C", "/repo", "hello"]);
});

test("buildCodewithExecArgs resumes an explicit session id (never --last)", () => {
  const args = buildCodewithExecArgs({ prompt: "again", outputFile: "/tmp/o.txt", sessionId: SESSION_UUID });
  expect(args.slice(0, 3)).toEqual(["exec", "resume", SESSION_UUID]);
  expect(args).not.toContain("--last");
});

test("buildAccountsCommand wraps codewith under an accounts profile", () => {
  const cmd = buildAccountsCommand("account088", ["exec", "hi"]);
  expect(cmd).toEqual(["accounts", "run", "codewith", "-p", "account088", "--", "exec", "hi"]);
});

test("extractCodewithSessionId finds ids across event shapes", () => {
  expect(extractCodewithSessionId('{"type":"session.created","session_id":"' + SESSION_UUID + '"}')).toBe(SESSION_UUID);
  expect(extractCodewithSessionId('{"msg":{"conversation_id":"' + SESSION_UUID + '"}}')).toBe(SESSION_UUID);
  expect(extractCodewithSessionId('{"type":"session_configured","session":{"id":"' + SESSION_UUID + '"}}')).toBe(SESSION_UUID);
  expect(extractCodewithSessionId('not json\n{"foo":"bar"}')).toBeUndefined();
});

test("extractCodewithLastMessage returns the last assistant text and ignores errors", () => {
  const jsonl = [
    '{"type":"task_started"}',
    '{"type":"agent_message","role":"assistant","text":"first"}',
    '{"type":"agent_message","role":"assistant","text":"final answer"}',
    '{"type":"error","message":"ignore me"}',
  ].join("\n");
  expect(extractCodewithLastMessage(jsonl)).toBe("final answer");
});

test("buildAgentEnv strips bridge channel secrets and credential-shaped keys", () => {
  const env = buildAgentEnv(config, config.profiles.cw, config.agents.cw, {
    PATH: "/usr/bin",
    HOME: "/home/x",
    TG_TOKEN: "SECRET-BOT-TOKEN",
    ANTHROPIC_API_KEY: "sk-should-be-stripped",
    SOME_PASSWORD: "nope",
    HARMLESS: "ok",
  });
  expect(env.PATH).toBe("/usr/bin");
  expect(env.HARMLESS).toBe("ok");
  expect(env.TG_TOKEN).toBeUndefined();
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.SOME_PASSWORD).toBeUndefined();
});

test("buildAgentEnv lets an explicit profile/agent env re-add a needed key", () => {
  const cfgWithEnv: BridgeConfig = {
    ...config,
    agents: { cw: { ...config.agents.cw, env: { ANTHROPIC_API_KEY: "explicit" } } },
  };
  const env = buildAgentEnv(cfgWithEnv, config.profiles.cw, cfgWithEnv.agents.cw, {
    ANTHROPIC_API_KEY: "from-station",
  });
  expect(env.ANTHROPIC_API_KEY).toBe("explicit");
});

test("resolveDurableTarget prefers the session's active profile session id", () => {
  const session = {
    agentSession: { kind: "codewith", mode: "durable", authProfile: "account088", providerSessions: { account088: SESSION_UUID } },
  } as unknown as BridgeSession;
  expect(resolveDurableTarget(config.profiles.cw, session)).toEqual({ authProfile: "account088", sessionId: SESSION_UUID });
});

test("runAgent durable path captures session id and isolates reply from JSONL stdout", async () => {
  const jsonl = [
    '{"type":"session.created","session_id":"' + SESSION_UUID + '"}',
    '{"type":"agent_message","role":"assistant","text":"raw event noise"}',
  ].join("\n");
  const outputs = new Map<string, string>();
  const spawn: AgentSpawn = async (command) => {
    // codewith would write the last-message file; emulate that here.
    const oIdx = command.indexOf("-o");
    if (oIdx >= 0) outputs.set(command[oIdx + 1]!, "clean user reply");
    return { exitCode: 0, stdout: jsonl, stderr: "", timedOut: false };
  };
  const result = await runAgent(config, "cw", {
    message: { id: "m", channelId: "tg", text: "hi", receivedAt: new Date(0).toISOString() },
    route: { id: "r", fromChannel: "tg", toAgent: "cw" },
  }, { spawn, readOutput: async (p) => outputs.get(p) });

  expect(result.command.slice(0, 3)).toEqual(["accounts", "run", "codewith"]);
  expect(result.command).toContain("account088");
  expect(result.providerSessionId).toBe(SESSION_UUID);
  expect(result.stdoutStructured).toBe(true);
  expect(result.replyText).toBe("clean user reply");
  // Raw JSONL must never become the reply.
  expect(result.replyText).not.toContain("session.created");
});

test("runAgent durable path resumes the stored session id on the next turn", async () => {
  const session = {
    id: "s", agentId: "cw", status: "active", createdAt: "", updatedAt: "",
    agentSession: { kind: "codewith", mode: "durable", authProfile: "account088", providerSessions: { account088: SESSION_UUID } },
  } as unknown as BridgeSession;
  let seen: string[] = [];
  const spawn: AgentSpawn = async (command) => {
    seen = command;
    return { exitCode: 0, stdout: "{}", stderr: "", timedOut: false };
  };
  await runAgent(config, "cw", {
    message: { id: "m2", channelId: "tg", text: "again", receivedAt: new Date(0).toISOString() },
    route: { id: "r", fromChannel: "tg", toAgent: "cw" },
    session,
  }, { spawn, readOutput: async () => "ok" });

  expect(seen).toContain("resume");
  expect(seen).toContain(SESSION_UUID);
});

test("recordDurableSession persists the captured id per profile", () => {
  const session = {
    agentSession: { kind: "codewith", mode: "durable", authProfile: "account088", providerSessions: {} },
  } as unknown as BridgeSession;
  const agent = { providerSessionId: SESSION_UUID, authProfile: "account088" } as AgentRunResult;
  expect(recordDurableSession(session, agent)).toBe(true);
  expect(session.agentSession?.providerSessions?.account088).toBe(SESSION_UUID);
  expect(session.agentSession?.refId).toBe(SESSION_UUID);
  // idempotent second call reports no change
  expect(recordDurableSession(session, agent)).toBe(false);
});

test("durable reply isolation flows through dispatch to Telegram", async () => {
  process.env["TG_TOKEN"] = "test-token";
  const bridgeState = state();
  let sentText = "";
  await dispatchMessageWithSessions(config, bridgeState, {
    id: "telegram:1", channelId: "tg", chatId: "1", text: "hi", receivedAt: new Date(0).toISOString(),
  }, {
    run: async (_c, agentId): Promise<AgentRunResult> => ({
      agentId, command: ["accounts"], exitCode: 0,
      stdout: '{"type":"session.created","session_id":"' + SESSION_UUID + '"}',
      stderr: "", timedOut: false,
      stdoutStructured: true, replyText: "hello from codewith",
      providerSessionId: SESSION_UUID, authProfile: "account088",
    }),
    sendTelegram: async (_t, _c, text) => { sentText = text; return { ok: true }; },
  });
  expect(sentText).toBe("hello from codewith");
  const binding = bridgeState.bindings["tg::telegram:tg:1"];
  const session = bridgeState.sessions[binding!.activeSessionId];
  expect(session.agentSession?.providerSessions?.account088).toBe(SESSION_UUID);
});
