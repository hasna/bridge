import { expect, test } from "bun:test";
import {
  CONTEXT_RESET_NOTE,
  createBridgeSession,
  runAgent,
  sendBridgeSessionMessage,
  type AgentSpawn,
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

const DEAD_SID = "aaaaaaaa-1111-2222-3333-444444444444";
const NEW_SID = "cccccccc-9999-8888-7777-666666666666";
const STALE_EVENT = '{"type":"error","error":{"type":"session_not_found","message":"no such session"}}';
const OUTAGE_EVENT = '{"type":"error","error":{"message":"upstream unavailable"}}';

function makeState(): BridgeState {
  return { schemaVersion: 2, telegramOffsets: {}, sessions: {}, bindings: {}, messageLedger: {}, cursors: {} };
}

function msg(id: string) {
  return { id, channelId: "local", text: `text-${id}`, receivedAt: new Date(0).toISOString() };
}

/**
 * Two-directional regression for the context-reset notice.
 *
 * Direction A (false positive): a stale-session heal whose fresh retry ALSO
 * failed must not claim the context was reset — nothing was healed and no reply
 * exists to carry the claim.
 *
 * Direction B (silent loss): dropping the dead `refId` on that failed turn means
 * the NEXT turn finds nothing to resume, so no heal fires and nothing would flag
 * the loss. The user's earlier conversation is gone; they must still be told,
 * exactly once, on the first turn that actually reaches them.
 */
test("a dropped dead thread is reported to the user on the next successful turn, exactly once", async () => {
  const state = makeState();
  const session = createBridgeSession(config, state, { agentId: "cw" });
  session.agentSession!.refId = DEAD_SID;

  const delivered: string[] = [];
  const writeConsole = (text: string) => { delivered.push(text); };

  let mode: "outage" | "healthy" = "outage";
  const spawn: AgentSpawn = async (command) => {
    const resumeIdx = command.indexOf("resume");
    const resuming = resumeIdx >= 0 ? command[resumeIdx + 1] : undefined;
    // Only the ORIGINAL thread is gone. A later thread resumes normally, so
    // turn 3 must not heal — any note it shows would be a repeat.
    if (resuming === DEAD_SID) return { exitCode: 1, stdout: STALE_EVENT, stderr: "", timedOut: false };
    if (mode === "outage") return { exitCode: 1, stdout: OUTAGE_EVENT, stderr: "", timedOut: false };
    return { exitCode: 0, stdout: `{"type":"thread.started","thread_id":"${resuming ?? NEW_SID}"}`, stderr: "", timedOut: false };
  };
  const run = ((c: BridgeConfig, agentId: string, input: Parameters<typeof runAgent>[2]) =>
    runAgent(c, agentId, input, { spawn, readOutput: async () => (mode === "healthy" ? "here you go" : undefined) })) as never;

  // Turn 1: the stored thread is gone AND the fresh retry fails (provider blip).
  const first = await sendBridgeSessionMessage(config, state, session.id, msg("a"), { run, writeConsole });
  expect(first.status).toBe("failed");
  // Direction A: no reset is claimed on the turn that healed nothing…
  expect(first.agent?.contextReset).toBeFalsy();
  expect(delivered).toHaveLength(0);
  // …but the dead pointer is gone and the loss is remembered.
  expect(session.agentSession?.refId).toBeUndefined();
  expect(session.agentSession?.contextResetPending).toBe(true);

  // Turn 2: provider recovers. Nothing to resume, so nothing heals — the notice
  // has to come from the remembered debt or the user is never told.
  mode = "healthy";
  const second = await sendBridgeSessionMessage(config, state, session.id, msg("b"), { run, writeConsole });
  expect(second.status).toBe("delivered");
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toContain(CONTEXT_RESET_NOTE);
  expect(delivered[0]).toContain("here you go");
  expect(session.agentSession?.refId).toBe(NEW_SID);
  expect(session.agentSession?.contextResetPending).toBeUndefined();

  // Turn 3: the debt is settled — the note must not repeat.
  const third = await sendBridgeSessionMessage(config, state, session.id, msg("c"), { run, writeConsole });
  expect(third.status).toBe("delivered");
  expect(delivered).toHaveLength(2);
  expect(delivered[1]).not.toContain(CONTEXT_RESET_NOTE);
});

/**
 * The debt must survive a restart between the failed turn and the next one, so
 * it lives on the persisted session ref rather than in memory. It must also
 * survive further failed turns: only a reply that reaches the user settles it.
 */
test("an unreported context loss is not settled by another failing turn", async () => {
  const state = makeState();
  const session = createBridgeSession(config, state, { agentId: "cw" });
  session.agentSession!.refId = DEAD_SID;

  const alwaysFails: AgentSpawn = async (command) => ({
    exitCode: 1,
    stdout: command.includes("resume") ? STALE_EVENT : OUTAGE_EVENT,
    stderr: "",
    timedOut: false,
  });
  const run = ((c: BridgeConfig, agentId: string, input: Parameters<typeof runAgent>[2]) =>
    runAgent(c, agentId, input, { spawn: alwaysFails, readOutput: async () => undefined })) as never;

  await sendBridgeSessionMessage(config, state, session.id, msg("a"), { run, writeConsole: false });
  expect(session.agentSession?.contextResetPending).toBe(true);

  // A second failed turn (now with no refId, so nothing even heals) must leave
  // the debt outstanding rather than quietly consuming it.
  await sendBridgeSessionMessage(config, state, session.id, msg("b"), { run, writeConsole: false });
  expect(session.agentSession?.contextResetPending).toBe(true);
});

/**
 * A turn can SUCCEED and still produce no reply text (`no_output`). The note
 * rides on the reply, so nothing reaches the user on such a turn — the debt must
 * survive it rather than being settled by a turn that told the user nothing.
 */
test("a successful but silent turn does not settle an unreported context loss", async () => {
  const state = makeState();
  const session = createBridgeSession(config, state, { agentId: "cw" });
  session.agentSession!.refId = DEAD_SID;

  const delivered: string[] = [];
  const writeConsole = (text: string) => { delivered.push(text); };

  let phase: "outage" | "silent" | "speaking" = "outage";
  const spawn: AgentSpawn = async (command) => {
    const resumeIdx = command.indexOf("resume");
    const resuming = resumeIdx >= 0 ? command[resumeIdx + 1] : undefined;
    if (resuming === DEAD_SID) return { exitCode: 1, stdout: STALE_EVENT, stderr: "", timedOut: false };
    if (phase === "outage") return { exitCode: 1, stdout: OUTAGE_EVENT, stderr: "", timedOut: false };
    return { exitCode: 0, stdout: `{"type":"thread.started","thread_id":"${resuming ?? NEW_SID}"}`, stderr: "", timedOut: false };
  };
  const run = ((c: BridgeConfig, agentId: string, input: Parameters<typeof runAgent>[2]) =>
    runAgent(c, agentId, input, {
      spawn,
      readOutput: async () => (phase === "speaking" ? "finally, an answer" : undefined),
    })) as never;

  // Turn 1: the loss happens and is remembered.
  await sendBridgeSessionMessage(config, state, session.id, msg("a"), { run, writeConsole });
  expect(session.agentSession?.contextResetPending).toBe(true);

  // Turn 2: the run succeeds but says nothing, so the user learns nothing.
  phase = "silent";
  const silent = await sendBridgeSessionMessage(config, state, session.id, msg("b"), { run, writeConsole });
  expect(silent.status).toBe("no_output");
  expect(delivered).toHaveLength(0);
  expect(session.agentSession?.contextResetPending).toBe(true);

  // Turn 3: the first turn that actually speaks carries the note.
  phase = "speaking";
  const spoken = await sendBridgeSessionMessage(config, state, session.id, msg("c"), { run, writeConsole });
  expect(spoken.status).toBe("delivered");
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toContain(CONTEXT_RESET_NOTE);
  expect(session.agentSession?.contextResetPending).toBeUndefined();
});
