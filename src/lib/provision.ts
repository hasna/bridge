import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentWorkspaceConfig, BridgeConfig } from "../types.js";

/**
 * Per-agent project + channel provisioning, following the existing station
 * convention (agent-ea / agent-marcus / agent-chief-of-staff): each agent owns
 *   1. its OWN projects-CLI project — a dedicated folder used as the agent cwd
 *      (convention root: ~/workspace/hasnaxyz/agent/agent-<name>), and
 *   2. its OWN conversations channel named `agent-<name>` where the agent posts
 *      activity, claims and results.
 * Provisioning is lazy (first run of the agent) and idempotent: existing
 * projects/channels are reused, and the result is persisted into the bridge
 * config so subsequent runs skip the CLI round-trips entirely.
 */

export interface ProvisionExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type ProvisionExec = (command: string[]) => Promise<ProvisionExecResult>;

export interface ProvisionDeps {
  /** Runs a provisioning CLI (projects/conversations); injectable for tests. */
  exec?: ProvisionExec;
  /** Persists the provisioned workspace back to the bridge config file. */
  persist?: (agentId: string, workspace: AgentWorkspaceConfig) => Promise<void>;
  /** Root folder for agent project folders; defaults to the station convention. */
  root?: string;
  log?: (message: string) => void;
}

/** Station convention root for agent project folders (see agent-chief-of-staff). */
export function agentWorkspaceRoot(): string {
  return process.env["BRIDGE_AGENT_WORKSPACE_ROOT"] || join(homedir(), "workspace", "hasnaxyz", "agent");
}

/** Convention name shared by the project and the channel: agent-<name>. */
export function agentProjectName(agentId: string): string {
  const slug = agentId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  return slug.startsWith("agent-") ? slug : `agent-${slug}`;
}

const defaultProvisionExec: ProvisionExec = async (command) => {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const exitCode = await proc.exited;
  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
};

/** Extracts a project id from `projects show/create --json` output (tolerates noise lines). */
export function parseProjectId(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("{");
  if (start === -1) return undefined;
  try {
    const parsed = JSON.parse(trimmed.slice(start)) as Record<string, unknown>;
    const candidates = [parsed, parsed["project"], parsed["workspace"], parsed["result"]];
    for (const candidate of candidates) {
      if (candidate && typeof candidate === "object") {
        const id = (candidate as Record<string, unknown>)["id"];
        if (typeof id === "string" && id) return id;
      }
    }
  } catch {
    // fall through: unparseable output means no id
  }
  return undefined;
}

function channelAlreadyExists(result: ProvisionExecResult): boolean {
  return /already ?exists|duplicate|exists/i.test(`${result.stdout}\n${result.stderr}`);
}

/**
 * In-flight/in-memory provisioning results, keyed per loaded config object so
 * unrelated configs (tests, one-shot CLI invocations) never share state. The
 * stored value is a Promise so concurrent messages for the same agent share a
 * single provisioning pass instead of racing duplicate CLI calls.
 */
const provisionCache = new WeakMap<BridgeConfig, Map<string, Promise<AgentWorkspaceConfig>>>();

async function provisionAgentWorkspace(
  config: BridgeConfig,
  agentId: string,
  deps: ProvisionDeps,
): Promise<AgentWorkspaceConfig> {
  const agent = config.agents[agentId];
  if (!agent) throw new Error(`Agent not found: ${agentId}`);
  const exec = deps.exec || defaultProvisionExec;
  const log = deps.log || (() => undefined);
  const name = agentProjectName(agentId);
  const workspace: AgentWorkspaceConfig = { ...(agent.workspace || {}) };
  workspace.path = workspace.path || join(deps.root || agentWorkspaceRoot(), name);
  workspace.channel = workspace.channel || name;

  // Fast path: a fully provisioned workspace whose folder still exists needs no
  // CLI round-trips at all — provisioning stays idempotent and cheap.
  if (workspace.projectId && workspace.provisionedAt && existsSync(workspace.path)) {
    agent.workspace = workspace;
    return workspace;
  }

  // The folder is the agent's cwd and must exist even if the CLIs are down.
  try {
    await mkdir(workspace.path, { recursive: true });
  } catch (err) {
    log(`[bridge] could not create agent workspace folder ${workspace.path}: ${err instanceof Error ? err.message : String(err)}`);
    delete workspace.path;
  }

  // 1. Own project via the projects CLI: reuse an existing `agent-<name>`
  //    project, otherwise create one rooted at the workspace folder.
  if (!workspace.projectId) {
    const shown = await exec(["projects", "show", name, "--json"]).catch((err) => ({
      exitCode: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err),
    }));
    if (shown.exitCode === 0) workspace.projectId = parseProjectId(shown.stdout);
    if (!workspace.projectId && workspace.path) {
      const created = await exec([
        "projects", "create", "--name", name, "--path", workspace.path, "--mkdir", "--json",
      ]).catch((err) => ({ exitCode: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) }));
      workspace.projectId = parseProjectId(created.stdout);
      if (!workspace.projectId) {
        log(`[bridge] projects create failed for ${name}: ${(created.stderr || created.stdout).trim().slice(0, 300)}`);
      }
    }
  }

  // 2. Own conversations channel `agent-<name>`; an existing channel is fine.
  const channelResult = await exec([
    "conversations", "channel", "create", workspace.channel,
    "--topic", `Bridge agent ${agentId}: activity, claims, and results`,
  ]).catch((err) => ({ exitCode: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) }));
  if (channelResult.exitCode !== 0 && !channelAlreadyExists(channelResult)) {
    log(`[bridge] conversations channel create failed for ${workspace.channel}: ${(channelResult.stderr || channelResult.stdout).trim().slice(0, 300)}`);
  }

  // Mark the pass complete only when the durable pieces are in place, so a
  // transient CLI failure is retried on a later run instead of sticking forever.
  if (workspace.projectId && workspace.path) {
    workspace.provisionedAt = new Date().toISOString();
  }

  agent.workspace = workspace;
  if (deps.persist) {
    try {
      await deps.persist(agentId, workspace);
    } catch (err) {
      log(`[bridge] could not persist workspace for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return workspace;
}

/**
 * Ensures the agent's own project folder + channel exist (lazily, idempotently)
 * and returns the workspace. Never throws for provisioning-CLI failures — the
 * agent run must not be blocked by a projects/conversations outage; whatever
 * could be provisioned is returned and the rest is retried on the next run.
 */
export function ensureAgentWorkspace(
  config: BridgeConfig,
  agentId: string,
  deps: ProvisionDeps = {},
): Promise<AgentWorkspaceConfig> {
  let byAgent = provisionCache.get(config);
  if (!byAgent) {
    byAgent = new Map();
    provisionCache.set(config, byAgent);
  }
  const cached = byAgent.get(agentId);
  if (cached) return cached;
  const pending = provisionAgentWorkspace(config, agentId, deps).then(
    (workspace) => {
      // A partial pass (e.g. projects CLI outage) must be retried on the next
      // run, so only fully provisioned workspaces stay cached.
      if (!workspace.provisionedAt) byAgent!.delete(agentId);
      return workspace;
    },
    (err) => {
      // Do not cache failures (e.g. unknown agent) — surface and allow retry.
      byAgent!.delete(agentId);
      throw err;
    },
  );
  byAgent.set(agentId, pending);
  return pending;
}
