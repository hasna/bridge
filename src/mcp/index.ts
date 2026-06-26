#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  attachBridgeSession,
  createBridgeSession,
  dispatchMessageWithSessions,
  doctor,
  getBridgeSession,
  listBridgeSessions,
  loadConfig,
  loadState,
  redactConfig,
  routeMessage,
  saveState,
  sendBridgeSessionMessage,
} from "../index.js";

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

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
      const state = await loadState();
      const result = await sendBridgeSessionMessage(config, state, args.sessionId, {
        id: `mcp:${Date.now()}`,
        channelId: "mcp",
        text: args.text,
        receivedAt: new Date().toISOString(),
      }, { writeConsole: false });
      await saveState(state);
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
      const state = await loadState();
      const result = await dispatchMessageWithSessions(config, state, {
        id: `mcp:${Date.now()}`,
        channelId: args.channelId,
        text: args.text,
        chatId: args.chatId,
        threadId: args.threadId,
        from: args.from,
        receivedAt: new Date().toISOString(),
      }, {
        writeConsole: false,
        fallbackToRoutes: Boolean(args.fallbackRoutes),
        persistState: async (nextState) => saveState(nextState),
      });
      await saveState(state);
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

  return server;
}

const server = buildServer();
await server.connect(new StdioServerTransport());
