import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgentEnv,
  buildCodewithCommand,
  buildCodewithExecArgs,
  dispatchMessageWithSessions,
  extractCodewithLastMessage,
  extractCodewithSessionId,
  loadState,
  recordDurableSession,
  resolveCodewithHome,
  resolveDurableTarget,
  runAgent,
  saveState,
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

test("buildCodewithExecArgs selects the billing account with codewith's native --auth-profile", () => {
  // Resuming the SAME thread while switching only the paying account: the flag
  // that makes rotation carry context.
  const args = buildCodewithExecArgs({ prompt: "again", outputFile: "/tmp/o.txt", sessionId: SESSION_UUID, authProfile: "account002" });
  expect(args.slice(0, 3)).toEqual(["exec", "resume", SESSION_UUID]);
  expect(args).toContain("--auth-profile");
  expect(args[args.indexOf("--auth-profile") + 1]).toBe("account002");
  // Prompt stays last positional.
  expect(args[args.length - 1]).toBe("again");
});

test("buildCodewithCommand invokes codewith directly (no store-forking accounts wrapper)", () => {
  const cmd = buildCodewithCommand(["exec", "hi"]);
  expect(cmd).toEqual(["codewith", "exec", "hi"]);
  expect(cmd).not.toContain("accounts");
});

test("resolveCodewithHome pins one shared home from env, else ~/.codewith", () => {
  expect(resolveCodewithHome({ CODEWITH_HOME: "/shared/.codewith", HOME: "/home/x" })).toBe("/shared/.codewith");
  expect(resolveCodewithHome({ HOME: "/home/x" })).toBe("/home/x/.codewith");
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

test("buildAgentEnv passes only the allow-list and drops everything else (incl. non-credential-shaped secrets)", () => {
  const env = buildAgentEnv(config, config.profiles.cw, config.agents.cw, {
    PATH: "/usr/bin",
    HOME: "/home/x",
    LC_ALL: "C",
    CODEWITH_HOME: "/home/x/.codewith",
    TG_TOKEN: "SECRET-BOT-TOKEN",
    ANTHROPIC_API_KEY: "sk-should-be-stripped",
    SOME_PASSWORD: "nope",
    // Station secrets that do NOT match a credential-shaped name — a deny-list
    // would leak these; the allow-list drops them because they are not listed.
    DATABASE_URL: "postgres://user:pw@host/db",
    AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
    TELEGRAM_SESSION: "1a2b3c",
    RANDOM_APP_STATE: "leak-me",
  });
  // Allow-listed vars survive.
  expect(env.PATH).toBe("/usr/bin");
  expect(env.HOME).toBe("/home/x");
  expect(env.LC_ALL).toBe("C");
  expect(env.CODEWITH_HOME).toBe("/home/x/.codewith");
  // Bridge secret + credential-shaped keys stripped.
  expect(env.TG_TOKEN).toBeUndefined();
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.SOME_PASSWORD).toBeUndefined();
  // Not-on-the-allow-list station vars (including secrets that dodge name patterns).
  expect(env.DATABASE_URL).toBeUndefined();
  expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
  expect(env.TELEGRAM_SESSION).toBeUndefined();
  expect(env.RANDOM_APP_STATE).toBeUndefined();
});

test("buildAgentEnv honours envPassthrough names and PREFIX* globs but still strips credential-shaped ones", () => {
  const cfg: BridgeConfig = {
    ...config,
    agents: { cw: { ...config.agents.cw, envPassthrough: ["MY_FLAG", "GIT_*"] } },
  };
  const env = buildAgentEnv(cfg, config.profiles.cw, cfg.agents.cw, {
    MY_FLAG: "1",
    GIT_AUTHOR_NAME: "bot",
    GIT_ACCESS_KEY: "should-still-be-stripped",
    OTHER: "no",
  });
  expect(env.MY_FLAG).toBe("1");
  expect(env.GIT_AUTHOR_NAME).toBe("bot");
  // Even an explicitly passed-through prefix cannot smuggle a credential-shaped key.
  expect(env.GIT_ACCESS_KEY).toBeUndefined();
  expect(env.OTHER).toBeUndefined();
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

test("resolveDurableTarget returns the shared thread id and the active billing account", () => {
  const session = {
    agentSession: { kind: "codewith", mode: "durable", authProfile: "account088", refId: SESSION_UUID },
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

  expect(result.command.slice(0, 2)).toEqual(["codewith", "exec"]);
  expect(result.command).toContain("--auth-profile");
  expect(result.command).toContain("account088");
  expect(result.command).not.toContain("accounts");
  expect(result.providerSessionId).toBe(SESSION_UUID);
  expect(result.stdoutStructured).toBe(true);
  expect(result.replyText).toBe("clean user reply");
  // Raw JSONL must never become the reply.
  expect(result.replyText).not.toContain("session.created");
});

test("runAgent durable path resumes the stored session id on the next turn", async () => {
  const session = {
    id: "s", agentId: "cw", status: "active", createdAt: "", updatedAt: "",
    agentSession: { kind: "codewith", mode: "durable", authProfile: "account088", refId: SESSION_UUID },
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

test("recordDurableSession persists the shared thread id and the active account", () => {
  const session = {
    agentSession: { kind: "codewith", mode: "durable", authProfile: "account088" },
  } as unknown as BridgeSession;
  const agent = { providerSessionId: SESSION_UUID, authProfile: "account088" } as AgentRunResult;
  expect(recordDurableSession(session, agent)).toBe(true);
  expect(session.agentSession?.refId).toBe(SESSION_UUID);
  expect(session.agentSession?.authProfile).toBe("account088");
  // idempotent second call reports no change
  expect(recordDurableSession(session, agent)).toBe(false);

  // Rotating the billing account keeps the SAME thread id, only re-points who pays.
  expect(recordDurableSession(session, { providerSessionId: SESSION_UUID, authProfile: "account001" } as AgentRunResult)).toBe(true);
  expect(session.agentSession?.refId).toBe(SESSION_UUID);
  expect(session.agentSession?.authProfile).toBe("account001");
});

test("a stored per-conversation thread_id survives a state save/load restart and resumes", async () => {
  process.env["TG_TOKEN"] = "test-token";
  const dir = await mkdtemp(join(tmpdir(), "bridge-state-"));
  const statePath = join(dir, "state.json");
  try {
    const first = state();
    // Turn 1: capture and persist the codewith thread id for this conversation.
    await dispatchMessageWithSessions(config, first, {
      id: "telegram:1", channelId: "tg", chatId: "1", text: "hi", receivedAt: new Date(0).toISOString(),
    }, {
      run: async (_c, agentId): Promise<AgentRunResult> => ({
        agentId, command: ["accounts"], exitCode: 0, stdout: "{}", stderr: "", timedOut: false,
        stdoutStructured: true, replyText: "one", providerSessionId: SESSION_UUID, authProfile: "account088",
      }),
      sendTelegram: async () => ({ ok: true }),
    });
    await saveState(first, statePath);

    // Restart: a brand-new state loaded from disk must still resume the same id.
    const reloaded = await loadState(statePath);
    const binding = reloaded.bindings["tg::telegram:tg:1"];
    expect(binding).toBeDefined();
    expect(reloaded.sessions[binding!.activeSessionId].agentSession?.refId).toBe(SESSION_UUID);

    let seen: string[] = [];
    await dispatchMessageWithSessions(config, reloaded, {
      id: "telegram:2", channelId: "tg", chatId: "1", text: "again", receivedAt: new Date(0).toISOString(),
    }, {
      run: (c, agentId, input) => runAgent(c, agentId, input, {
        spawn: async (command) => { seen = command; return { exitCode: 0, stdout: "{}", stderr: "", timedOut: false }; },
        readOutput: async () => "two",
      }),
      sendTelegram: async () => ({ ok: true }),
    });
    expect(seen).toContain("resume");
    expect(seen).toContain(SESSION_UUID);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
  expect(session.agentSession?.refId).toBe(SESSION_UUID);
});
