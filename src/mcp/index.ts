#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { doctor, loadConfig, routeMessage } from "../index.js";

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: "bridge", version: "0.1.0" });

  server.tool("bridge_status", {}, async () => text(await doctor()));

  server.tool("bridge_config", {}, async () => text(await loadConfig()));

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
