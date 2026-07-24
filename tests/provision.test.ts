import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentProjectName,
  ensureAgentWorkspace,
  parseProjectId,
  type AgentWorkspaceConfig,
  type BridgeConfig,
  type ProvisionExec,
  type ProvisionExecResult,
} from "../src/index.js";

function makeConfig(): BridgeConfig {
  return {
    version: 1,
    channels: {},
    profiles: { cw: { id: "cw", agentKind: "codewith", authProfile: "account006" } },
    agents: { "owner-agent": { id: "owner-agent", kind: "codewith", profileId: "cw" } },
    routes: [],
  };
}

interface FakeExec {
  exec: ProvisionExec;
  calls: string[][];
}

function fakeExec(results: Record<string, ProvisionExecResult>): FakeExec {
  const calls: string[][] = [];
  return {
    calls,
    exec: async (command) => {
      calls.push(command);
      const key = command.slice(0, 3).join(" ");
      return results[key] ?? { exitCode: 0, stdout: "{}", stderr: "" };
    },
  };
}

const PROJECT_JSON = JSON.stringify({ project: { id: "wks_agent123", primary_path: "/x" } });

test("agentProjectName follows the agent-<name> convention", () => {
  expect(agentProjectName("owner-agent")).toBe("agent-owner-agent");
  expect(agentProjectName("agent-marcus")).toBe("agent-marcus");
  expect(agentProjectName("My Agent!")).toBe("agent-my-agent");
});

test("parseProjectId reads projects CLI json (with noise tolerance)", () => {
  expect(parseProjectId(PROJECT_JSON)).toBe("wks_agent123");
  expect(parseProjectId(`some log line\n${PROJECT_JSON}`)).toBe("wks_agent123");
  expect(parseProjectId('{"id":"wks_direct"}')).toBe("wks_direct");
  expect(parseProjectId("not json")).toBeUndefined();
});

test("first use provisions the agent's own project folder and agent-<name> channel", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-prov-"));
  try {
    const config = makeConfig();
    const { exec, calls } = fakeExec({
      // No pre-existing project: show fails, create succeeds.
      "projects show agent-owner-agent": { exitCode: 1, stdout: "", stderr: "not found" },
      "projects create --name": { exitCode: 0, stdout: PROJECT_JSON, stderr: "" },
    });
    const persisted: Array<{ agentId: string; workspace: AgentWorkspaceConfig }> = [];

    const workspace = await ensureAgentWorkspace(config, "owner-agent", {
      exec,
      root,
      persist: async (agentId, ws) => { persisted.push({ agentId, workspace: ws }); },
    });

    expect(workspace.path).toBe(join(root, "agent-owner-agent"));
    expect(existsSync(workspace.path!)).toBe(true);
    expect(workspace.projectId).toBe("wks_agent123");
    expect(workspace.channel).toBe("agent-owner-agent");
    expect(workspace.provisionedAt).toBeDefined();

    // projects create was called with the convention name + folder.
    const create = calls.find((c) => c[0] === "projects" && c[1] === "create")!;
    expect(create).toContain("agent-owner-agent");
    expect(create).toContain(workspace.path!);
    // conversations channel create agent-<name> was called.
    const channel = calls.find((c) => c[0] === "conversations")!;
    expect(channel.slice(0, 4)).toEqual(["conversations", "channel", "create", "agent-owner-agent"]);

    // The workspace is wired into the agent config and persisted.
    expect(config.agents["owner-agent"]!.workspace).toEqual(workspace);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.workspace.projectId).toBe("wks_agent123");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provisioning is idempotent: an existing project is reused, an existing channel is fine", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-prov-"));
  try {
    const config = makeConfig();
    const { exec, calls } = fakeExec({
      "projects show agent-owner-agent": { exitCode: 0, stdout: PROJECT_JSON, stderr: "" },
      "conversations channel create": { exitCode: 1, stdout: "", stderr: "channel already exists: agent-owner-agent" },
    });

    const workspace = await ensureAgentWorkspace(config, "owner-agent", { exec, root });
    expect(workspace.projectId).toBe("wks_agent123");
    expect(workspace.provisionedAt).toBeDefined();
    // Reused, not re-created.
    expect(calls.some((c) => c[0] === "projects" && c[1] === "create")).toBe(false);

    // Second call in the same process: fully cached, zero additional CLI calls.
    const before = calls.length;
    const again = await ensureAgentWorkspace(config, "owner-agent", { exec, root });
    expect(again).toEqual(workspace);
    expect(calls.length).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a pre-provisioned workspace from config short-circuits without any CLI calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-prov-"));
  try {
    const config = makeConfig();
    config.agents["owner-agent"]!.workspace = {
      projectId: "wks_persisted",
      path: root, // exists
      channel: "agent-owner-agent",
      provisionedAt: new Date(0).toISOString(),
    };
    const { exec, calls } = fakeExec({});
    const workspace = await ensureAgentWorkspace(config, "owner-agent", { exec, root });
    expect(workspace.projectId).toBe("wks_persisted");
    expect(calls).toHaveLength(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a projects CLI outage still yields a usable folder and is retried next run", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-prov-"));
  try {
    const config = makeConfig();
    const { exec, calls } = fakeExec({
      "projects show agent-owner-agent": { exitCode: 1, stdout: "", stderr: "boom" },
      "projects create --name": { exitCode: 1, stdout: "", stderr: "registry down" },
    });
    const logs: string[] = [];
    const workspace = await ensureAgentWorkspace(config, "owner-agent", { exec, root, log: (m) => logs.push(m) });
    // The run is NOT blocked: the folder exists and is usable as cwd.
    expect(workspace.path).toBe(join(root, "agent-owner-agent"));
    expect(existsSync(workspace.path!)).toBe(true);
    expect(workspace.projectId).toBeUndefined();
    expect(workspace.provisionedAt).toBeUndefined();
    expect(logs.some((l) => l.includes("projects create failed"))).toBe(true);

    // Partial passes are not cached: the next run retries provisioning.
    const before = calls.length;
    await ensureAgentWorkspace(config, "owner-agent", { exec, root });
    expect(calls.length).toBeGreaterThan(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureAgentWorkspace rejects unknown agents", async () => {
  const config = makeConfig();
  expect(ensureAgentWorkspace(config, "nope", { exec: fakeExec({}).exec })).rejects.toThrow("Agent not found");
});
