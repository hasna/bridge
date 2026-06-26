import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import {
  attachBridgeSession,
  createBridgeSession,
  dispatchMessageWithSessions,
  getIMessageMessages,
  imessageHandleAllowed,
  imessageRowToMessage,
  loadConfig,
  routeMessage,
  renderSendIMessageScript,
  saveConfig,
  sendIMessage,
  type AgentRunResult,
  type BridgeState,
  type BridgeConfig,
  type IMessageChannelConfig,
} from "../src/index.js";

const channel: IMessageChannelConfig = {
  id: "im",
  kind: "imessage",
  enabled: true,
  allowedHandles: ["+15555550100"],
  defaultHandle: "+15555550100",
  receiveMode: "disabled",
};

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", "src/cli/index.ts", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("renders and runs iMessage send through osascript without touching Messages in tests", async () => {
  const script = renderSendIMessageScript(channel, "+15555550100", "hello \"bridge\"");
  expect(script).toContain("tell application \"Messages\"");
  expect(script).toContain("hello \\\"bridge\\\"");

  const accountScript = renderSendIMessageScript({ ...channel, account: "andrei@example.com" }, "+15555550100", "hello");
  expect(accountScript).toContain("account = \"andrei@example.com\"");

  const chatScript = renderSendIMessageScript({ ...channel, allowAllHandles: true }, "chat:iMessage;-;group-guid", "hello");
  expect(chatScript).toContain("1st chat whose id = \"iMessage;-;group-guid\"");

  let command: string[] = [];
  const sent = await sendIMessage(channel, "+15555550100", "hello", {
    run: async (cmd) => {
      command = cmd;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  expect(sent).toEqual({ ok: true });
  expect(command[0]).toBe("osascript");
  expect(command[1]).toBe("-e");
});

test("iMessage send fails closed outside the allowlist", async () => {
  expect(imessageHandleAllowed(channel, "+15555550100")).toBe(true);
  expect(imessageHandleAllowed(channel, "+15555550199")).toBe(false);
  await expect(sendIMessage(channel, "+15555550199", "hello", {
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  })).rejects.toThrow("not allowed");
});

test("reads allowed inbound rows from a fixture Messages chat.db", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-imessage-"));
  const path = join(dir, "chat.db");
  const db = new Database(path);
  db.run("create table handle (ROWID integer primary key, id text)");
  db.run("create table message (ROWID integer primary key, handle_id integer, text text, date integer, is_from_me integer)");
  db.run("create table chat (ROWID integer primary key, guid text, display_name text)");
  db.run("create table chat_message_join (chat_id integer, message_id integer)");
  db.run("insert into handle (ROWID, id) values (1, '+15555550100'), (2, '+15555550199')");
  db.run("insert into chat (ROWID, guid, display_name) values (1, 'iMessage;-;+15555550100', 'One'), (2, 'iMessage;-;group-guid', 'Group')");
  db.run("insert into message (ROWID, handle_id, text, date, is_from_me) values (10, 1, 'hello', 0, 0)");
  db.run("insert into message (ROWID, handle_id, text, date, is_from_me) values (11, 2, 'blocked', 0, 0)");
  db.run("insert into message (ROWID, handle_id, text, date, is_from_me) values (12, 1, 'sent by me', 0, 1)");
  db.run("insert into chat_message_join (chat_id, message_id) values (1, 10), (1, 11), (1, 12)");
  db.close();

  const rows = getIMessageMessages({
    ...channel,
    receiveMode: "chat-db",
    chatDbPath: path,
  });

  expect(rows).toEqual([{ rowId: 10, handle: "+15555550100", chatGuid: "iMessage;-;+15555550100", displayName: "One", text: "hello", date: 0 }]);
  expect(imessageRowToMessage("im", rows[0]!).chatId).toBe("chat:iMessage;-;+15555550100");
  expect(imessageRowToMessage("im", rows[0]!).responseTargetId).toBe("chat:iMessage;-;+15555550100");
});

test("iMessage polling scans past disallowed rows and preserves group chat identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-imessage-"));
  const path = join(dir, "chat.db");
  const db = new Database(path);
  db.run("create table handle (ROWID integer primary key, id text)");
  db.run("create table message (ROWID integer primary key, handle_id integer, text text, date integer, is_from_me integer)");
  db.run("create table chat (ROWID integer primary key, guid text, display_name text)");
  db.run("create table chat_message_join (chat_id integer, message_id integer)");
  db.run("insert into handle (ROWID, id) values (1, '+15555550100'), (2, '+15555550199')");
  db.run("insert into chat (ROWID, guid, display_name) values (1, 'iMessage;-;group-guid', 'Group')");
  db.run("insert into message (ROWID, handle_id, text, date, is_from_me) values (10, 2, 'blocked first', 0, 0)");
  db.run("insert into message (ROWID, handle_id, text, date, is_from_me) values (11, 1, 'allowed second', 0, 0)");
  db.run("insert into chat_message_join (chat_id, message_id) values (1, 10), (1, 11)");
  db.close();

  const rows = getIMessageMessages({
    ...channel,
    receiveMode: "chat-db",
    chatDbPath: path,
    pollLimit: 1,
  });

  expect(rows.map((row) => row.rowId)).toEqual([11]);
  expect(imessageRowToMessage("im", rows[0]!).chatId).toBe("chat:iMessage;-;group-guid");
});

test("CLI adds iMessage channel config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-imessage-cli-"));
  const configPath = join(dir, "config.json");
  const initial: BridgeConfig = { version: 1, channels: {}, profiles: {}, agents: {}, routes: [] };
  await saveConfig(initial, configPath);

  const result = await runCli([
    "channels",
    "add-imessage",
    "im",
    "--allowed-handles",
    "+15555550100",
    "--default-handle",
    "+15555550100",
    "--account",
    "andrei@example.com",
    "--receive",
    "--chat-db-path",
    join(dir, "chat.db"),
    "--config",
    configPath,
    "--json",
  ]);

  expect(result.exitCode).toBe(0);
  const saved = await loadConfig(configPath);
  expect(saved.channels.im?.kind).toBe("imessage");
  expect(saved.channels.im && "receiveMode" in saved.channels.im ? saved.channels.im.receiveMode : undefined).toBe("chat-db");
  expect(saved.channels.im && "account" in saved.channels.im ? saved.channels.im.account : undefined).toBe("andrei@example.com");
});

test("CLI rejects explicit iMessage handle without message text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-imessage-cli-"));
  const configPath = join(dir, "config.json");
  const initial: BridgeConfig = { version: 1, channels: { im: channel }, profiles: {}, agents: {}, routes: [] };
  await saveConfig(initial, configPath);

  const result = await runCli(["send", "im", "+15555550100", "--config", configPath]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("message text is required");
});

test("disallowed iMessage handles do not invoke agents through session or route compatibility", async () => {
  const config: BridgeConfig = {
    version: 1,
    channels: { im: channel },
    profiles: {},
    agents: { echo: { id: "echo", kind: "shell", command: "printf", args: ["ok"] } },
    routes: [{ id: "im-echo", fromChannel: "im", toAgent: "echo", enabled: true }],
  };
  const state: BridgeState = {
    schemaVersion: 2,
    telegramOffsets: {},
    sessions: {},
    bindings: {},
    messageLedger: {},
    cursors: {},
  };
  const session = createBridgeSession(config, state, { id: "ses_im", agentId: "echo" });
  attachBridgeSession(config, state, { sessionId: session.id, channelId: "im", conversation: "+15555550199" });
  let runs = 0;
  const run = async (_config: BridgeConfig, agentId: string): Promise<AgentRunResult> => {
    runs++;
    return { agentId, command: ["fake"], exitCode: 0, stdout: "bad", stderr: "", timedOut: false };
  };
  const message = {
    id: "imessage:999",
    channelId: "im",
    chatId: "+15555550199",
    from: "+15555550199",
    text: "blocked",
    receivedAt: new Date(0).toISOString(),
  };

  const sessionResult = await dispatchMessageWithSessions(config, state, message, { run, fallbackToRoutes: true });
  const routeResult = await routeMessage(config, message, { run });

  expect(sessionResult.session?.status).toBe("unauthorized");
  expect(routeResult).toEqual([]);
  expect(runs).toBe(0);
});
