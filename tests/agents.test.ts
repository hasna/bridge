import { expect, test } from "bun:test";
import { buildAgentCommand, resolveAgent, type BridgeConfig } from "../src/index.js";

const baseConfig: BridgeConfig = {
  version: 1,
  channels: {},
  profiles: {
    "cw-main": {
      id: "cw-main",
      agentKind: "codewith",
      authProfile: "account001",
      cwd: "/repo",
    },
    "claude-main": {
      id: "claude-main",
      agentKind: "claude",
      home: "/profiles/claude/account001",
    },
  },
  agents: {
    codewith: { id: "codewith", kind: "codewith", profileId: "cw-main" },
    claude: { id: "claude", kind: "claude", profileId: "claude-main" },
    custom: { id: "custom", kind: "shell", command: "printf", args: ["%s", "{prompt}"] },
  },
  routes: [],
};

const input = {
  message: {
    id: "msg",
    channelId: "telegram",
    text: "hello",
    receivedAt: new Date(0).toISOString(),
  },
  route: { id: "r", fromChannel: "telegram", toAgent: "codewith" },
};

test("renders codewith command with auth profile and cwd", () => {
  const result = buildAgentCommand(baseConfig, "codewith", input);
  expect(result.command).toEqual(["codewith", "--auth-profile", "account001", "--cd", "/repo", "exec", "hello"]);
  expect(result.cwd).toBe("/repo");
});

test("renders claude command with profile HOME", () => {
  const result = buildAgentCommand(baseConfig, "claude", { ...input, route: { ...input.route, toAgent: "claude" } });
  expect(result.command.slice(0, 3)).toEqual(["claude", "-p", "hello"]);
  expect(result.env?.HOME).toBe("/profiles/claude/account001");
});

test("renders custom command prompt placeholder", () => {
  const result = buildAgentCommand(baseConfig, "custom", { ...input, route: { ...input.route, toAgent: "custom" } });
  expect(result.command).toEqual(["printf", "%s", "hello"]);
});

test("rejects profile kind mismatches", () => {
  const config: BridgeConfig = {
    ...baseConfig,
    agents: {
      bad: { id: "bad", kind: "codewith", profileId: "claude-main" },
    },
  };
  expect(() => resolveAgent(config, "bad")).toThrow("not codewith");
});
