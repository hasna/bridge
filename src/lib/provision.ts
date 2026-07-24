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

/** Project fields extracted from projects-CLI `--json` output. */
export interface ParsedProjectRecord {
  id?: string;
  /**
   * `primary_path` of the registry record: a string when set, `null` when the
   * registry explicitly reports no primary path (api-mode `projects create`
   * registers the project without applying path/dir effects), and `undefined`
   * when the output did not carry the field at all.
   */
  primaryPath?: string | null;
}

/**
 * Collects every plausible project object from projects-CLI `--json` output:
 * the bare object, `project`/`workspace`/`result` wrappers, the prompt-agent
 * run wrapper's `projects` array, and `tool_calls[].output.project|workspace`
 * (the only place the record appears for an `already_exists` agent run).
 */
function projectCandidates(parsed: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [parsed];
  for (const key of ["project", "workspace", "result"]) {
    const value = parsed[key];
    if (value && typeof value === "object" && !Array.isArray(value)) out.push(value as Record<string, unknown>);
  }
  const projects = parsed["projects"];
  if (Array.isArray(projects)) {
    for (const value of projects) {
      if (value && typeof value === "object") out.push(value as Record<string, unknown>);
    }
  }
  const toolCalls = parsed["tool_calls"];
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      const output = call && typeof call === "object" ? (call as Record<string, unknown>)["output"] : undefined;
      if (!output || typeof output !== "object") continue;
      for (const key of ["project", "workspace"]) {
        const value = (output as Record<string, unknown>)[key];
        if (value && typeof value === "object") out.push(value as Record<string, unknown>);
      }
    }
  }
  return out;
}

/** Extracts the project id + primary_path from `projects show/create/update --json` output (tolerates noise lines). */
export function parseProjectRecord(stdout: string): ParsedProjectRecord {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("{");
  if (start === -1) return {};
  try {
    const parsed = JSON.parse(trimmed.slice(start)) as Record<string, unknown>;
    for (const candidate of projectCandidates(parsed)) {
      const id = candidate["id"];
      if (typeof id !== "string" || !id) continue;
      const primary = candidate["primary_path"];
      return {
        id,
        primaryPath: typeof primary === "string" && primary ? primary : primary === null ? null : undefined,
      };
    }
  } catch {
    // fall through: unparseable output means no record
  }
  return {};
}

/** Extracts a project id from `projects show/create --json` output (tolerates noise lines). */
export function parseProjectId(stdout: string): string | undefined {
  return parseProjectRecord(stdout).id;
}

/**
 * Whether a failed `conversations channel create` genuinely means the channel
 * already exists (which is fine and counts as provisioned). Matches only
 * genuine duplicate shapes — "already exists", "duplicate", a conflict, or an
 * HTTP 409 status (the conversations CLI reports a duplicate channel as
 * `Hasna cloud request failed: POST /channels -> 409`). Deliberately narrow:
 * a bare `exists` would also match unrelated failures such as
 * "no such tenant exists" and mask a real outage.
 */
function channelAlreadyExists(result: ProvisionExecResult): boolean {
  const text = `${result.stdout}\n${result.stderr}`;
  return /\balready[ _-]?exists\b|\bduplicate\b|\bconflict\b|(?:->|status:?|code:?)\s*409\b/i.test(text);
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
  //    project, otherwise create one rooted at the workspace folder. `--yes`
  //    approves the create's path/dir effects (without it the project is
  //    registered with primary_path=null and no directory).
  let registryPrimaryPath: string | null | undefined;
  if (!workspace.projectId) {
    const shown = await exec(["projects", "show", name, "--json"]).catch((err) => ({
      exitCode: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err),
    }));
    if (shown.exitCode === 0) {
      const record = parseProjectRecord(shown.stdout);
      workspace.projectId = record.id;
      registryPrimaryPath = record.primaryPath;
    }
    if (!workspace.projectId && workspace.path) {
      const created = await exec([
        "projects", "create", "--name", name, "--path", workspace.path, "--mkdir", "--json", "--yes",
      ]).catch((err) => ({ exitCode: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) }));
      let record = parseProjectRecord(created.stdout);
      if (!record.id) {
        // `create --yes` routes through the projects prompt-agent, which can
        // register the project without echoing the record (or stop at a plan).
        // Re-read by name before concluding anything, so we never duplicate.
        const reshown = await exec(["projects", "show", name, "--json"]).catch((err) => ({
          exitCode: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err),
        }));
        if (reshown.exitCode === 0) record = parseProjectRecord(reshown.stdout);
      }
      if (!record.id) {
        // Deterministic fallback: the plain create registers the project in
        // both api and local mode without a prompt-agent round-trip. Path/dir
        // effects it may skip are covered by the bridge's own mkdir above and
        // the primary-path pinning below.
        log(`[bridge] projects create --yes yielded no project for ${name} (${(created.stderr || created.stdout).trim().slice(0, 200)}); falling back to deterministic create`);
        const fallback = await exec([
          "projects", "create", "--name", name, "--path", workspace.path, "--mkdir", "--json",
        ]).catch((err) => ({ exitCode: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) }));
        record = parseProjectRecord(fallback.stdout);
        if (!record.id) {
          log(`[bridge] projects create failed for ${name}: ${(fallback.stderr || fallback.stdout).trim().slice(0, 300)}`);
        }
      }
      workspace.projectId = record.id;
      registryPrimaryPath = record.primaryPath;
    }
  } else {
    // Resumed partial pass (e.g. the channel failed last time): re-read the
    // record so a previously unpinned primary_path is still fixed up below.
    const shown = await exec(["projects", "show", workspace.projectId, "--json"]).catch((err) => ({
      exitCode: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err),
    }));
    if (shown.exitCode === 0) registryPrimaryPath = parseProjectRecord(shown.stdout).primaryPath;
  }

  // 1b. Pin the primary path when the registry record explicitly lacks one:
  //     in api-mode the create registers the project WITHOUT applying path/dir
  //     effects, leaving primary_path=null. `projects update --path` is
  //     deterministic and works in both api and local mode.
  let projectPathPinned = true;
  if (workspace.projectId && workspace.path && registryPrimaryPath === null) {
    const updated = await exec([
      "projects", "update", workspace.projectId, "--path", workspace.path, "--json",
    ]).catch((err) => ({ exitCode: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) }));
    const pinned = parseProjectRecord(updated.stdout).primaryPath;
    projectPathPinned = updated.exitCode === 0 && typeof pinned === "string" && pinned.length > 0;
    if (!projectPathPinned) {
      log(`[bridge] projects update --path failed for ${name}: ${(updated.stderr || updated.stdout).trim().slice(0, 300)}`);
    }
  }

  // 2. Own conversations channel `agent-<name>`; an existing channel is fine.
  //    Tracked separately from project provisioning so a conversations outage
  //    retries ONLY the channel on the next run — and, conversely, a projects
  //    outage does not re-create an already confirmed channel.
  if (!workspace.channelProvisionedAt) {
    const channelResult = await exec([
      "conversations", "channel", "create", workspace.channel,
      "--topic", `Bridge agent ${agentId}: activity, claims, and results`,
    ]).catch((err) => ({ exitCode: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) }));
    if (channelResult.exitCode === 0 || channelAlreadyExists(channelResult)) {
      workspace.channelProvisionedAt = new Date().toISOString();
    } else {
      log(`[bridge] conversations channel create failed for ${workspace.channel}: ${(channelResult.stderr || channelResult.stdout).trim().slice(0, 300)}`);
    }
  }

  // Mark the pass complete only when ALL durable pieces are in place — project
  // (id + pinned path) AND channel — so any transient CLI failure is retried on
  // a later run instead of sticking forever.
  if (workspace.projectId && workspace.path && projectPathPinned && workspace.channelProvisionedAt) {
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
