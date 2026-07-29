import { expect, test } from "bun:test";
import {
  createBridgeSession,
  sendBridgeSessionMessage,
  type AgentRunResult,
  type BridgeConfig,
  type BridgeState,
} from "../src/index.js";

const config: BridgeConfig = {
  version: 1,
  channels: { local: { id: "local", kind: "console", enabled: true } },
  profiles: { cw: { id: "cw", agentKind: "codewith", authProfile: "account088" } },
  agents: { cw: { id: "cw", kind: "codewith", profileId: "cw" } },
  routes: [],
};

const SID = "11111111-2222-3333-4444-555555555555";

function makeState(): BridgeState {
  return { schemaVersion: 2, telegramOffsets: {}, sessions: {}, bindings: {}, messageLedger: {}, cursors: {} };
}

function msg(id: string) {
  return { id, channelId: "local", text: `text-${id}`, receivedAt: new Date(0).toISOString() };
}

/**
 * Regression: nothing serialised turns on a single bridge session.
 *
 * `bridge_session_send` / `bridge_session_route_message` are MCP tools, and the
 * MCP SDK does not serialise tool invocations, so two messages for one session
 * could run concurrently. Both turns then execute
 * `codewith exec resume <same thread id>` against the SAME rollout file in the
 * shared codewith home (the whole point of the shared thread store), and both
 * race to write the session ref back. The result is an interleaved/corrupted
 * codewith thread and a lost thread id.
 *
 * A durable session must process one turn at a time.
 */
test("two concurrent messages for the same session run one at a time", async () => {
  const state = makeState();
  const session = createBridgeSession(config, state, { agentId: "cw" });

  let active = 0;
  let maxActive = 0;
  const resumedIds: (string | undefined)[] = [];

  const run = async (
    _config: BridgeConfig,
    agentId: string,
    input: { session?: { agentSession?: { refId?: string } } },
  ): Promise<AgentRunResult> => {
    resumedIds.push(input.session?.agentSession?.refId);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 40));
    active -= 1;
    return {
      agentId, command: ["codewith"], exitCode: 0, stdout: "{}", stderr: "", timedOut: false,
      stdoutStructured: true, replyText: "ok", providerSessionId: SID, authProfile: "account088",
    };
  };

  await Promise.all([
    sendBridgeSessionMessage(config, state, session.id, msg("a"), { run: run as never, writeConsole: false }),
    sendBridgeSessionMessage(config, state, session.id, msg("b"), { run: run as never, writeConsole: false }),
  ]);

  // Serialised: the two turns never overlap.
  expect(maxActive).toBe(1);
  // And because they are serialised, the second turn sees the thread id the
  // first one established, so it resumes instead of forking a new thread.
  expect(resumedIds[0]).toBeUndefined();
  expect(resumedIds[1]).toBe(SID);
});

test("different sessions still run in parallel", async () => {
  const state = makeState();
  const one = createBridgeSession(config, state, { agentId: "cw" });
  const two = createBridgeSession(config, state, { agentId: "cw" });

  let active = 0;
  let maxActive = 0;
  const run = async (_config: BridgeConfig, agentId: string): Promise<AgentRunResult> => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 40));
    active -= 1;
    return { agentId, command: ["codewith"], exitCode: 0, stdout: "{}", stderr: "", timedOut: false, stdoutStructured: true, replyText: "ok" };
  };

  await Promise.all([
    sendBridgeSessionMessage(config, state, one.id, msg("a"), { run: run as never, writeConsole: false }),
    sendBridgeSessionMessage(config, state, two.id, msg("b"), { run: run as never, writeConsole: false }),
  ]);

  expect(maxActive).toBe(2);
});

/**
 * A turn that throws must release the session, otherwise one failing agent run
 * would deadlock the conversation permanently.
 */
test("a failing turn does not wedge the session queue", async () => {
  const state = makeState();
  const session = createBridgeSession(config, state, { agentId: "cw" });

  const boom = sendBridgeSessionMessage(config, state, session.id, msg("a"), {
    run: (async () => {
      throw new Error("agent blew up");
    }) as never,
    writeConsole: false,
  });
  await expect(boom).rejects.toThrow("agent blew up");

  const after = await sendBridgeSessionMessage(config, state, session.id, msg("b"), {
    run: (async (_c: BridgeConfig, agentId: string): Promise<AgentRunResult> => ({
      agentId, command: ["codewith"], exitCode: 0, stdout: "{}", stderr: "", timedOut: false,
      stdoutStructured: true, replyText: "recovered",
    })) as never,
    writeConsole: false,
  });
  expect(after.status).toBe("delivered");
}, 10_000);
