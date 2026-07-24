import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentFailureText,
  dispatchMessageWithSessions,
  extractCodewithErrorMessage,
  filterAgentLogNoise,
  handleInboundMessage,
  notifyDeadLetter,
  runAgent,
  type AgentRunResult,
  type AgentSpawn,
  type BridgeConfig,
  type BridgeState,
  type ProvisionExec,
} from "../src/index.js";

process.env["TG_TOKEN"] = "test-token";

/** Live-shaped config: no cwd anywhere, so the agent's own project folder applies. */
function makeConfig(): BridgeConfig {
  return {
    version: 1,
    channels: {
      tg: {
        id: "tg", kind: "telegram", enabled: true, botTokenEnv: "TG_TOKEN",
        allowedChatIds: ["1"], defaultAgentId: "owner-agent",
      },
    },
    profiles: { cw: { id: "cw", agentKind: "codewith", authProfile: "account006" } },
    agents: { "owner-agent": { id: "owner-agent", kind: "codewith", profileId: "cw" } },
    routes: [],
  };
}

function makeState(): BridgeState {
  return { schemaVersion: 2, telegramOffsets: {}, sessions: {}, bindings: {}, messageLedger: {}, cursors: {} };
}

const SHELL_SNAPSHOT_NOISE =
  "2026-07-24T14:24:27.130694Z ERROR codex_core::shell_snapshot: Shell snapshot validation failed: Snapshot command exited with status exit status: 2";

const PROVIDER_ERROR_EVENT = JSON.stringify({
  type: "error",
  message: JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: "The model is not supported" } }),
});

test("durable runs execute in the agent's OWN provisioned project folder when no cwd is configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-yolo-"));
  try {
    const config = makeConfig();
    const provisionExec: ProvisionExec = async (command) => ({
      exitCode: 0,
      stdout: command[0] === "projects" ? '{"project":{"id":"wks_owner"}}' : "{}",
      stderr: "",
    });
    let spawnedCwd: string | undefined;
    let seen: string[] = [];
    const spawn: AgentSpawn = async (command, options) => {
      seen = command;
      spawnedCwd = options.cwd;
      return { exitCode: 0, stdout: "{}", stderr: "", timedOut: false };
    };

    await runAgent(config, "owner-agent", {
      message: { id: "m", channelId: "tg", chatId: "1", text: "do it", receivedAt: new Date(0).toISOString() },
      route: { id: "r", fromChannel: "tg", toAgent: "owner-agent" },
    }, { spawn, readOutput: async () => "ok", provision: { exec: provisionExec, root } });

    const expectedCwd = join(root, "agent-owner-agent");
    // The agent process runs from its own project folder…
    expect(spawnedCwd).toBe(expectedCwd);
    // …and codewith is told the same via -C.
    const cIdx = seen.indexOf("-C");
    expect(cIdx).toBeGreaterThan(-1);
    expect(seen[cIdx + 1]).toBe(expectedCwd);
    // Full YOLO invocation: act (write/exec) and escape the folder when needed.
    expect(seen).toContain("--skip-git-repo-check");
    expect(seen).toContain("--dangerously-bypass-approvals-and-sandbox");
    // Durable runs invoke codewith directly (shared thread store), selecting the
    // billing account with codewith's native --auth-profile.
    expect(seen[0]).toBe("codewith");
    expect(seen).toContain("--auth-profile");
    expect(seen[seen.indexOf("--auth-profile") + 1]).toBe("account006");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shell_snapshot validation warnings on stderr do not break a successful run", async () => {
  const config = makeConfig();
  const state = makeState();
  let sentText = "";
  const outcome = await handleInboundMessage(config, state, {
    id: "telegram:10", channelId: "tg", chatId: "1", text: "hi", receivedAt: new Date(0).toISOString(),
  }, {
    run: async (_c, agentId): Promise<AgentRunResult> => ({
      agentId, command: ["accounts"], exitCode: 0,
      stdout: '{"type":"agent_message","role":"assistant","text":"done"}',
      stderr: SHELL_SNAPSHOT_NOISE,
      timedOut: false, stdoutStructured: true, replyText: "done",
    }),
    sendTelegram: async (_t, _c, text) => { sentText = text; return { ok: true }; },
  });
  expect(outcome.ledgerStatus).toBe("delivered");
  expect(outcome.deadLettered).toBe(false);
  expect(sentText).toBe("done");
});

test("filterAgentLogNoise strips tool log lines but keeps real errors", () => {
  const noisy = `${SHELL_SNAPSHOT_NOISE}\nerror: something real broke\nReading additional input from stdin...`;
  expect(filterAgentLogNoise(noisy)).toBe("error: something real broke");
});

test("extractCodewithErrorMessage unwraps nested JSON-encoded provider errors", () => {
  expect(extractCodewithErrorMessage(PROVIDER_ERROR_EVENT)).toBe("The model is not supported");
  const turnFailed = JSON.stringify({ type: "turn.failed", error: { message: "boom" } });
  expect(extractCodewithErrorMessage(turnFailed)).toBe("boom");
  expect(extractCodewithErrorMessage('{"type":"agent_message","text":"fine"}')).toBeUndefined();
});

test("agentFailureText prefers the structured error over stderr noise", () => {
  const agent = {
    agentId: "owner-agent", command: [], exitCode: 1, timedOut: false,
    stdout: PROVIDER_ERROR_EVENT,
    stderr: SHELL_SNAPSHOT_NOISE,
    stdoutStructured: true,
  } as unknown as AgentRunResult;
  expect(agentFailureText(agent)).toBe("The model is not supported");
});

test("a failed agent run surfaces a clear ERROR REPLY to Telegram instead of a silent dead-letter", async () => {
  const config = makeConfig();
  const state = makeState();
  const sent: string[] = [];
  const sendTelegram = async (_t: string, _c: string, text: string) => { sent.push(text); return { ok: true }; };
  const options = {
    maxAttempts: 1,
    run: async (_c: BridgeConfig, agentId: string): Promise<AgentRunResult> => ({
      agentId, command: ["accounts"], exitCode: 1,
      stdout: PROVIDER_ERROR_EVENT,
      stderr: SHELL_SNAPSHOT_NOISE,
      timedOut: false, stdoutStructured: true,
    }),
    sendTelegram,
    onDeadLetter: async (message: Parameters<typeof notifyDeadLetter>[1], entry: Parameters<typeof notifyDeadLetter>[2]) => {
      await notifyDeadLetter(config, message, entry, { sendTelegram });
    },
  };

  const outcome = await handleInboundMessage(config, state, {
    id: "telegram:11", channelId: "tg", chatId: "1", text: "act", receivedAt: new Date(0).toISOString(),
  }, options);

  expect(outcome.deadLettered).toBe(true);
  expect(outcome.ledgerStatus).toBe("dead_letter");
  // The sender got an explicit, human-readable error reply.
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("⚠️ I could not process that message");
  expect(sent[0]).toContain("The model is not supported");
  // The noise line never reaches the user.
  expect(sent[0]).not.toContain("shell_snapshot");
});

test("dispatch records the clear failure text on the ledger for the dead-letter notice", async () => {
  const config = makeConfig();
  const state = makeState();
  await expect(dispatchMessageWithSessions(config, state, {
    id: "telegram:12", channelId: "tg", chatId: "1", text: "act", receivedAt: new Date(0).toISOString(),
  }, {
    run: async (_c, agentId): Promise<AgentRunResult> => ({
      agentId, command: ["accounts"], exitCode: 1,
      stdout: PROVIDER_ERROR_EVENT, stderr: "", timedOut: false, stdoutStructured: true,
    }),
    sendTelegram: async () => ({ ok: true }),
  })).rejects.toThrow("The model is not supported");
  const entry = state.messageLedger["tg::telegram:12"];
  expect(entry?.status).toBe("failed");
  expect(entry?.error).toBe("The model is not supported");
});
