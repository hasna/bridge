#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  attachBridgeSession,
  broadcast,
  getBroadcast,
  listBroadcasts,
  recordBroadcast,
  createBridgeSession,
  dispatchMessageWithSessions,
  doctor,
  getBridgeSession,
  listBridgeSessions,
  loadConfig,
  loadState,
  messageSessionId,
  redactConfig,
  routeMessage,
  saveState,
  sendBridgeSessionMessage,
  withSessionStateTurn,
  type SessionStateStore,
} from "../index.js";

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

/**
 * State store for the message-sending tools. The MCP SDK does not serialise tool
 * invocations, so each call would otherwise parse its own state snapshot and the
 * later one would overwrite whatever the earlier turn persisted; passing this to
 * `withSessionStateTurn` moves the load and the save inside the session lock.
 */
const stateStore: SessionStateStore = { load: () => loadState(), save: (state) => saveState(state) };

export function buildServer(): McpServer {
  const server = new McpServer({ name: "bridge", version: "0.2.1" });

  server.tool("bridge_status", {}, async () => text(await doctor()));

  server.tool("bridge_config", {}, async () => text(redactConfig(await loadConfig())));

  server.tool("bridge_session_list", {}, async () => text(listBridgeSessions(await loadState())));

  server.tool(
    "bridge_session_status",
    { sessionId: z.string() },
    async (args) => text(getBridgeSession(await loadState(), args.sessionId)),
  );

  server.tool(
    "bridge_session_create",
    {
      agentId: z.string(),
      title: z.string().optional(),
      cwd: z.string().optional(),
    },
    async (args) => {
      const config = await loadConfig();
      const state = await loadState();
      const session = createBridgeSession(config, state, { agentId: args.agentId, title: args.title, cwd: args.cwd });
      await saveState(state);
      return text(session);
    },
  );

  server.tool(
    "bridge_session_attach",
    {
      sessionId: z.string(),
      channelId: z.string(),
      conversation: z.string(),
      makeDefault: z.boolean().optional(),
    },
    async (args) => {
      const config = await loadConfig();
      const state = await loadState();
      const binding = attachBridgeSession(config, state, {
        sessionId: args.sessionId,
        channelId: args.channelId,
        conversation: args.conversation,
        makeDefault: args.makeDefault,
      });
      await saveState(state);
      return text(binding);
    },
  );

  server.tool(
    "bridge_session_send",
    {
      sessionId: z.string(),
      text: z.string(),
    },
    async (args) => {
      const config = await loadConfig();
      const result = await withSessionStateTurn(args.sessionId, stateStore, (state) =>
        sendBridgeSessionMessage(config, state, args.sessionId, {
          id: `mcp:${Date.now()}`,
          channelId: "mcp",
          text: args.text,
          receivedAt: new Date().toISOString(),
        }, { writeConsole: false }));
      return text(result);
    },
  );

  server.tool(
    "bridge_session_route_message",
    {
      channelId: z.string(),
      text: z.string(),
      chatId: z.string().optional(),
      threadId: z.string().optional(),
      from: z.string().optional(),
      fallbackRoutes: z.boolean().optional(),
    },
    async (args) => {
      const config = await loadConfig();
      const message = {
        id: `mcp:${Date.now()}`,
        channelId: args.channelId,
        text: args.text,
        chatId: args.chatId,
        threadId: args.threadId,
        from: args.from,
        receivedAt: new Date().toISOString(),
      };
      // The lock key is the bound session, which is only knowable from state; the
      // turn re-reads state under the lock, so this probe read is a key lookup
      // and never the snapshot the turn runs on.
      const sessionId = messageSessionId(config, await loadState(), message);
      const result = await withSessionStateTurn(sessionId, stateStore, (state) =>
        dispatchMessageWithSessions(config, state, message, {
          writeConsole: false,
          fallbackToRoutes: Boolean(args.fallbackRoutes),
          persistState: (nextState) => stateStore.save(nextState),
        }));
      return text(result);
    },
  );

  server.tool(
    "bridge_route_message",
    {
      channelId: z.string(),
      text: z.string(),
      chatId: z.string().optional(),
      from: z.string().optional(),
    },
    async (args) => {
      const config = await loadConfig();
      const result = await routeMessage(config, {
        id: `mcp:${Date.now()}`,
        channelId: args.channelId,
        text: args.text,
        chatId: args.chatId,
        from: args.from,
        receivedAt: new Date().toISOString(),
      });
      return text(result);
    },
  );

  server.tool(
    "bridge_broadcast",
    {
      channelId: z.string().describe("Channel to broadcast on (telegram or console)"),
      text: z.string().describe("Message text to post to every target"),
      targets: z.array(z.string()).optional().describe("Override target chat ids (defaults to the channel's broadcastChatIds)"),
    },
    async (args) => {
      const config = await loadConfig();
      const result = await broadcast(config, args.channelId, args.text, {
        targets: args.targets,
        writeConsole: false,
      });
      const state = await loadState();
      recordBroadcast(state, result);
      await saveState(state);
      return text(result);
    },
  );

  server.tool(
    "bridge_broadcast_reports",
    {
      channelId: z.string().optional(),
      limit: z.number().int().positive().optional(),
      broadcastId: z.string().optional().describe("Return a single report by id"),
    },
    async (args) => {
      const state = await loadState();
      if (args.broadcastId) return text(getBroadcast(state, args.broadcastId) ?? `No broadcast report: ${args.broadcastId}`);
      return text(listBroadcasts(state, { channelId: args.channelId, limit: args.limit ?? 20 }));
    },
  );

  return server;
}

const server = buildServer();
await server.connect(new StdioServerTransport());
