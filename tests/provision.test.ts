import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentProjectName,
  ensureAgentWorkspace,
  parseProjectId,
  parseProjectRecord,
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

test("parseProjectRecord reads id + primary_path across projects CLI output shapes", () => {
  // Plain `projects show --json` wrapper.
  expect(parseProjectRecord(PROJECT_JSON)).toEqual({ id: "wks_agent123", primaryPath: "/x" });
  // Registered without path effects (api-mode create): primary_path is explicitly null.
  expect(parseProjectRecord('{"project":{"id":"wks_a","primary_path":null}}')).toEqual({ id: "wks_a", primaryPath: null });
  // Prompt-agent run wrapper (`create --yes`): record lives in `projects: [...]`.
  const aiRun = JSON.stringify({ mode: "ai", run_id: "run_1", projects: [{ id: "wks_ai", primary_path: "/p" }], tool_calls: [] });
  expect(parseProjectRecord(aiRun)).toEqual({ id: "wks_ai", primaryPath: "/p" });
  // already_exists agent run: `projects` is empty, the record only appears in tool_calls output.
  const existsRun = JSON.stringify({
    mode: "ai", run_id: "run_2", projects: [],
    tool_calls: [{ name: "projects_create", output: { status: "already_exists", project: { id: "wks_dup", primary_path: null } } }],
  });
  expect(parseProjectRecord(existsRun)).toEqual({ id: "wks_dup", primaryPath: null });
  expect(parseProjectRecord("not json")).toEqual({});
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

    // projects create was called with the convention name + folder, approved
    // with --yes so path/dir effects (primary_path, mkdir) actually apply.
    const create = calls.find((c) => c[0] === "projects" && c[1] === "create")!;
    expect(create).toContain("agent-owner-agent");
    expect(create).toContain(workspace.path!);
    expect(create).toContain("--yes");
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

test("BUG1: a failed channel create is NOT marked provisioned and is retried on the next run", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-prov-"));
  try {
    const config = makeConfig();
    const calls: string[][] = [];
    let channelAttempts = 0;
    const exec: ProvisionExec = async (command) => {
      calls.push(command);
      if (command[0] === "projects" && command[1] === "show") return { exitCode: 0, stdout: PROJECT_JSON, stderr: "" };
      if (command[0] === "conversations") {
        channelAttempts += 1;
        // Simulated transient conversations outage on the first run only.
        if (channelAttempts === 1) return { exitCode: 1, stdout: "", stderr: "conversations api unavailable (HTTP 500)" };
        return { exitCode: 0, stdout: "channel created: agent-owner-agent", stderr: "" };
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };
    const logs: string[] = [];

    const first = await ensureAgentWorkspace(config, "owner-agent", { exec, root, log: (m) => logs.push(m) });
    // The project half succeeded, the channel half did not: the pass must NOT
    // be marked complete, or the channel would never be retried.
    expect(first.projectId).toBe("wks_agent123");
    expect(first.channelProvisionedAt).toBeUndefined();
    expect(first.provisionedAt).toBeUndefined();
    expect(logs.some((l) => l.includes("channel create failed"))).toBe(true);

    const second = await ensureAgentWorkspace(config, "owner-agent", { exec, root });
    // The channel was retried (and only the channel — no project re-create).
    expect(channelAttempts).toBe(2);
    expect(second.channelProvisionedAt).toBeDefined();
    expect(second.provisionedAt).toBeDefined();
    expect(calls.some((c) => c[0] === "projects" && c[1] === "create")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a projects outage does not re-create an already confirmed channel on retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-prov-"));
  try {
    const config = makeConfig();
    let projectsUp = false;
    let channelCreates = 0;
    const exec: ProvisionExec = async (command) => {
      if (command[0] === "projects") {
        if (!projectsUp) return { exitCode: 1, stdout: "", stderr: "projects registry down" };
        return { exitCode: 0, stdout: PROJECT_JSON, stderr: "" };
      }
      channelCreates += 1;
      return { exitCode: 0, stdout: "channel created", stderr: "" };
    };

    const first = await ensureAgentWorkspace(config, "owner-agent", { exec, root });
    expect(first.projectId).toBeUndefined();
    expect(first.channelProvisionedAt).toBeDefined();
    expect(first.provisionedAt).toBeUndefined();
    expect(channelCreates).toBe(1);

    projectsUp = true;
    const second = await ensureAgentWorkspace(config, "owner-agent", { exec, root });
    expect(second.projectId).toBe("wks_agent123");
    expect(second.provisionedAt).toBeDefined();
    // The confirmed channel was tracked separately and NOT re-created.
    expect(channelCreates).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unrelated failures containing 'exists' (e.g. 'no such tenant exists') are NOT treated as channel-already-exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-prov-"));
  try {
    const config = makeConfig();
    const { exec } = fakeExec({
      "projects show agent-owner-agent": { exitCode: 0, stdout: PROJECT_JSON, stderr: "" },
      "conversations channel create": { exitCode: 1, stdout: "", stderr: "no such tenant exists" },
    });
    const workspace = await ensureAgentWorkspace(config, "owner-agent", { exec, root });
    // A real failure must stay a failure: not confirmed, retried next run.
    expect(workspace.channelProvisionedAt).toBeUndefined();
    expect(workspace.provisionedAt).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an HTTP 409 duplicate from the conversations CLI counts as channel-already-exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-prov-"));
  try {
    const config = makeConfig();
    const { exec } = fakeExec({
      "projects show agent-owner-agent": { exitCode: 0, stdout: PROJECT_JSON, stderr: "" },
      // Real on-station shape for a duplicate channel (verified on station01).
      "conversations channel create": { exitCode: 1, stdout: "", stderr: "Hasna cloud request failed: POST /channels -> 409" },
    });
    const workspace = await ensureAgentWorkspace(config, "owner-agent", { exec, root });
    expect(workspace.channelProvisionedAt).toBeDefined();
    expect(workspace.provisionedAt).toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a registry record with primary_path=null is pinned via projects update --path", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-prov-"));
  try {
    const config = makeConfig();
    const expectedPath = join(root, "agent-owner-agent");
    const calls: string[][] = [];
    const exec: ProvisionExec = async (command) => {
      calls.push(command);
      if (command[0] === "projects" && command[1] === "show") return { exitCode: 1, stdout: "", stderr: "not found" };
      if (command[0] === "projects" && command[1] === "create") {
        // api-mode create --yes: project registered, but path/dir effects not applied.
        return { exitCode: 0, stdout: JSON.stringify({ projects: [{ id: "wks_agent123", primary_path: null }] }), stderr: "" };
      }
      if (command[0] === "projects" && command[1] === "update") {
        return { exitCode: 0, stdout: JSON.stringify({ project: { id: "wks_agent123", primary_path: command[4] } }), stderr: "" };
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };

    const workspace = await ensureAgentWorkspace(config, "owner-agent", { exec, root });
    expect(workspace.projectId).toBe("wks_agent123");
    expect(workspace.provisionedAt).toBeDefined();
    const update = calls.find((c) => c[0] === "projects" && c[1] === "update")!;
    expect(update).toEqual(["projects", "update", "wks_agent123", "--path", expectedPath, "--json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a prompt-agent create that returns no record falls back to the deterministic create", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-prov-"));
  try {
    const config = makeConfig();
    const expectedPath = join(root, "agent-owner-agent");
    const calls: string[][] = [];
    const exec: ProvisionExec = async (command) => {
      calls.push(command);
      if (command[0] === "projects" && command[1] === "show") return { exitCode: 1, stdout: "", stderr: "not found" };
      if (command[0] === "projects" && command[1] === "create") {
        if (command.includes("--yes")) {
          // Prompt-agent run that stopped at a plan: no project record echoed.
          return { exitCode: 0, stdout: JSON.stringify({ mode: "ai", projects: [], tool_calls: [] }), stderr: "" };
        }
        // Deterministic create: registers the project (api mode → null path).
        return { exitCode: 0, stdout: JSON.stringify({ project: { id: "wks_agent123", primary_path: null } }), stderr: "" };
      }
      if (command[0] === "projects" && command[1] === "update") {
        return { exitCode: 0, stdout: JSON.stringify({ project: { id: "wks_agent123", primary_path: command[4] } }), stderr: "" };
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };

    const workspace = await ensureAgentWorkspace(config, "owner-agent", { exec, root });
    expect(workspace.projectId).toBe("wks_agent123");
    expect(workspace.provisionedAt).toBeDefined();
    // The prompt-agent create ran first (--yes), then the deterministic fallback,
    // then the primary path was pinned.
    const creates = calls.filter((c) => c[0] === "projects" && c[1] === "create");
    expect(creates).toHaveLength(2);
    expect(creates[0]).toContain("--yes");
    expect(creates[1]).not.toContain("--yes");
    const update = calls.find((c) => c[0] === "projects" && c[1] === "update")!;
    expect(update).toEqual(["projects", "update", "wks_agent123", "--path", expectedPath, "--json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed primary_path pin keeps provisioning incomplete and is retried next run", async () => {
  const root = await mkdtemp(join(tmpdir(), "bridge-prov-"));
  try {
    const config = makeConfig();
    let updateAttempts = 0;
    const NULL_PATH_RECORD = JSON.stringify({ project: { id: "wks_agent123", primary_path: null } });
    const exec: ProvisionExec = async (command) => {
      if (command[0] === "projects" && command[1] === "show") {
        // By name (first pass) → not found; by id (retry pass) → null path record.
        return command[2] === "wks_agent123"
          ? { exitCode: 0, stdout: NULL_PATH_RECORD, stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "not found" };
      }
      if (command[0] === "projects" && command[1] === "create") return { exitCode: 0, stdout: NULL_PATH_RECORD, stderr: "" };
      if (command[0] === "projects" && command[1] === "update") {
        updateAttempts += 1;
        if (updateAttempts === 1) return { exitCode: 1, stdout: "", stderr: "registry write failed" };
        return { exitCode: 0, stdout: JSON.stringify({ project: { id: "wks_agent123", primary_path: command[4] } }), stderr: "" };
      }
      return { exitCode: 0, stdout: "{}", stderr: "" };
    };

    const first = await ensureAgentWorkspace(config, "owner-agent", { exec, root });
    expect(first.projectId).toBe("wks_agent123");
    expect(first.provisionedAt).toBeUndefined();

    const second = await ensureAgentWorkspace(config, "owner-agent", { exec, root });
    expect(updateAttempts).toBe(2);
    expect(second.provisionedAt).toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ─── BUG2 end-to-end: REAL projects CLI in an isolated temp root ──────────────
// Proves `projects create … --yes` (the exact argv the bridge ships) results in
// a registered project with a NON-NULL primary_path pointing at the agent
// folder, and that the folder exists. The projects CLI runs against an isolated
// local store (temp HASNA_PROJECTS_HOME/DB, api-mode env stripped) so the
// shared registry is never touched; the conversations CLI is stubbed so no real
// channel is created. Skipped when the projects CLI is not installed.
const PROJECTS_BIN = Bun.which("projects");

test.skipIf(!PROJECTS_BIN || Boolean(process.env["BRIDGE_SKIP_REAL_PROJECTS_TEST"]))(
  "BUG2 (real projects CLI): provisioning yields a non-null primary_path and an existing folder",
  async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "bridge-prov-real-"));
    try {
      const isolatedEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) isolatedEnv[key] = value;
      }
      // Local isolated store: never the shared/cloud registry.
      delete isolatedEnv["HASNA_PROJECTS_API_URL"];
      delete isolatedEnv["HASNA_PROJECTS_API_KEY"];
      isolatedEnv["HASNA_PROJECTS_HOME"] = join(tempRoot, "projects-home");
      isolatedEnv["HASNA_PROJECTS_DB_PATH"] = join(tempRoot, "projects.db");
      // Never let the projects CLI auto-create a real conversations channel.
      isolatedEnv["PROJECTS_CHANNEL_ENSURE"] = "0";

      const realExec: ProvisionExec = async (command) => {
        // Real spawn for the projects CLI; conversations is stubbed (no real channels).
        if (command[0] !== "projects") return { exitCode: 0, stdout: "{}", stderr: "" };
        const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: isolatedEnv });
        const exitCode = await proc.exited;
        return { exitCode, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
      };

      const config = makeConfig();
      const workspace = await ensureAgentWorkspace(config, "owner-agent", {
        exec: realExec,
        root: join(tempRoot, "agents"),
      });

      expect(workspace.projectId).toBeDefined();
      expect(workspace.path).toBe(join(tempRoot, "agents", "agent-owner-agent"));
      expect(existsSync(workspace.path!)).toBe(true);
      expect(workspace.provisionedAt).toBeDefined();

      // The REGISTRY record has a non-null primary_path pointing at the agent folder.
      const shown = await realExec(["projects", "show", workspace.projectId!, "--json"]);
      expect(shown.exitCode).toBe(0);
      const record = parseProjectRecord(shown.stdout);
      expect(record.id).toBe(workspace.projectId!);
      expect(record.primaryPath).toBe(workspace.path!);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  },
  240_000,
);
