import { expect, test } from "bun:test";
import {
  buildAgentCommand,
  cancelAgentSession,
  closeAgentSession,
  createAgentSessionRef,
  resumeAgentSessionRef,
  resolveAgent,
  sendAgentSessionMessage,
  type AgentRunResult,
  type BridgeConfig,
  type BridgeSession,
} from "../src/index.js";

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

test("creates explicit compatibility agent session refs", () => {
  const ref = createAgentSessionRef(baseConfig, "codewith");
  expect(ref.kind).toBe("codewith");
  expect(ref.mode).toBe("compatibility");
  expect(ref.detail).toContain("compatibility mode");
});

test("sends session messages through the injectable runner", async () => {
  const session: BridgeSession = {
    id: "ses_test",
    agentId: "codewith",
    profileId: "cw-main",
    cwd: "/repo",
    status: "active",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    agentSession: createAgentSessionRef(baseConfig, "codewith"),
  };
  const result = await sendAgentSessionMessage(baseConfig, session, input.message, {
    run: async (_config, agentId, runInput): Promise<AgentRunResult> => ({
      agentId,
      command: ["fake"],
      cwd: runInput.session?.cwd,
      exitCode: 0,
      stdout: `ok:${runInput.route.id}:${runInput.message.text}`,
      stderr: "",
      timedOut: false,
    }),
  });

  expect(result.stdout).toBe("ok:session:ses_test:hello");
  expect(result.cwd).toBe("/repo");
});

test("session cwd overrides agent and profile cwd", () => {
  const session: BridgeSession = {
    id: "ses_cwd",
    agentId: "codewith",
    profileId: "cw-main",
    cwd: "/session-repo",
    status: "active",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  const result = buildAgentCommand(baseConfig, "codewith", { ...input, session });
  expect(result.cwd).toBe("/session-repo");
  expect(result.command).toEqual(["codewith", "--auth-profile", "account001", "--cd", "/session-repo", "exec", "hello"]);
});

test("reports compatibility resume cancel and close limitations", () => {
  const session: BridgeSession = {
    id: "ses_test",
    agentId: "codewith",
    status: "active",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    agentSession: createAgentSessionRef(baseConfig, "codewith"),
  };

  expect(resumeAgentSessionRef(session).supported).toBe(false);
  expect(cancelAgentSession(session).supported).toBe(false);
  expect(closeAgentSession(session).supported).toBe(false);
});
