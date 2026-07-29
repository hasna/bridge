import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

async function readPid(path: string): Promise<number> {
  const pid = Number.parseInt((await readFile(path, "utf-8")).trim(), 10);
  if (!Number.isInteger(pid)) throw new Error(`bad pid in ${path}`);
  return pid;
}

/**
 * Regression for the handle `detached: true` takes away.
 *
 * Before `detached`, agents shared the station's process group, so the group
 * signal `bridge daemon stop` sends (daemon.ts -> `process.kill(-pid, ...)`)
 * reaped the in-flight agent on BOTH the graceful and the forced path. Adding
 * `detached` — which the run timeout needs — opted agents out of that signal
 * entirely, with three consequences this test pins down:
 *
 *  1. A stop no longer reaped an authenticated, approvals-bypassed codewith
 *     tree; it was orphaned with no parent left to enforce its timeout.
 *  2. `serve` registers its shutdown hook with `process.once`, so a SECOND
 *     SIGTERM — systemd's shutdown escalation — skipped it. A reaper installed
 *     with `once` would have the same hole, hence `on`.
 *  3. A stop no longer shortened the in-flight run, so `serve` stayed inside
 *     `await handleInboundMessage` for the agent's own budget (default 120s)
 *     while the daemon only waits 5s — making plain `bridge daemon stop` throw
 *     "did not stop within 5000ms" whenever a message was being processed.
 */
test("SIGTERM reaps in-flight agents and keeps doing so on a second signal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-reaper-"));
  let host: ReturnType<typeof Bun.spawn> | undefined;
  const strays: number[] = [];
  try {
    const indexPath = join(import.meta.dir, "..", "src", "index.ts");
    const scriptPath = join(dir, "host.ts");
    await writeFile(scriptPath, `
import { writeFileSync } from "node:fs";
import { spawnAgentProcess } from ${JSON.stringify(indexPath)};

// A permanent listener, so the reaper never has to re-raise and this host stays
// alive across both signals under test.
let phase = 0;
process.on("SIGTERM", () => { phase += 1; });

function startAgent(n) {
  void spawnAgentProcess(
    ["sh", "-lc", "echo $$ > ${dir}/agent" + n + ".pid; sleep 60"],
    { timeoutMs: 60000, killGraceMs: 300 },
  ).then(() => writeFileSync("${dir}/agent" + n + ".returned", "1")).catch(() => undefined);
}

startAgent(1);
setTimeout(() => writeFileSync("${dir}/ready1", "1"), 400);

let started2 = false;
let seen2 = false;
const iv = setInterval(() => {
  if (phase >= 1 && !started2) {
    started2 = true;
    startAgent(2);
    setTimeout(() => writeFileSync("${dir}/ready2", "1"), 400);
  }
  if (phase >= 2 && !seen2) {
    seen2 = true;
    // Deliberately stay ALIVE. If this host exited, the exit-time reaper would
    // clean up agent 2 and mask whether the SIGTERM handler is still installed.
    writeFileSync("${dir}/phase2", "1");
  }
}, 50);
`);

    host = Bun.spawn(["bun", "run", scriptPath], { stdout: "pipe", stderr: "pipe" });

    // ── first signal ────────────────────────────────────────────────────────
    await waitFor("first agent to start", () => existsSync(join(dir, "ready1")));
    const agent1 = await readPid(join(dir, "agent1.pid"));
    strays.push(agent1);
    expect(pidAlive(agent1)).toBe(true);

    process.kill(host.pid, "SIGTERM");

    // Consequence 1: the agent's process group is reaped.
    await waitFor("first agent to be reaped", () => !pidAlive(agent1));
    // Consequence 3: the run RETURNS instead of burning its full 60s budget, so
    // serve leaves handleInboundMessage well inside the daemon's stop window.
    await waitFor("first run to return", () => existsSync(join(dir, "agent1.returned")));

    // ── second signal ───────────────────────────────────────────────────────
    // Consequence 2: a reaper registered with `once` would already be gone, and
    // this second agent would survive as an orphan.
    await waitFor("second agent to start", () => existsSync(join(dir, "ready2")));
    const agent2 = await readPid(join(dir, "agent2.pid"));
    strays.push(agent2);
    expect(pidAlive(agent2)).toBe(true);

    process.kill(host.pid, "SIGTERM");
    // The host observed the signal and is STILL RUNNING, so the only thing that
    // can reap agent 2 is a signal handler that survived the first signal.
    await waitFor("host to observe the second signal", () => existsSync(join(dir, "phase2")));
    expect(pidAlive(host.pid)).toBe(true);
    await waitFor("second agent to be reaped", () => !pidAlive(agent2));
  } finally {
    for (const pid of strays) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already reaped
      }
    }
    host?.kill(9);
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

/**
 * Merely registering a signal listener suppresses Node's default termination, so
 * a reaper installed in a library module must restore it when nothing else is
 * listening — otherwise a one-shot `bridge send` would stop dying on SIGTERM.
 */
test("a host with no other signal handler still dies on SIGTERM", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-reaper-"));
  let host: ReturnType<typeof Bun.spawn> | undefined;
  let agent = 0;
  try {
    const indexPath = join(import.meta.dir, "..", "src", "index.ts");
    const scriptPath = join(dir, "oneshot.ts");
    await writeFile(scriptPath, `
import { writeFileSync } from "node:fs";
import { spawnAgentProcess } from ${JSON.stringify(indexPath)};
void spawnAgentProcess(["sh", "-lc", "echo $$ > ${dir}/agent.pid; sleep 60"], { timeoutMs: 60000 }).catch(() => undefined);
setTimeout(() => writeFileSync("${dir}/ready", "1"), 400);
setInterval(() => {}, 1000);
`);

    host = Bun.spawn(["bun", "run", scriptPath], { stdout: "pipe", stderr: "pipe" });
    await waitFor("agent to start", () => existsSync(join(dir, "ready")));
    agent = await readPid(join(dir, "agent.pid"));

    process.kill(host.pid, "SIGTERM");
    const exited = await Promise.race([
      host.exited.then(() => true),
      Bun.sleep(10_000).then(() => false),
    ]);
    expect(exited).toBe(true);
    await waitFor("agent to be reaped", () => !pidAlive(agent));
  } finally {
    if (agent) {
      try {
        process.kill(-agent, "SIGKILL");
      } catch {
        // already reaped
      }
    }
    host?.kill(9);
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);

/**
 * `serve` registers its graceful stop listener with `once` before it starts an
 * agent. EventEmitter removes a one-shot listener immediately before invoking
 * it, so a reaper that runs afterwards sees only itself and re-raises SIGTERM,
 * killing serve before it can finish the turn and persist state. The reaper must
 * run first, leave the host alive, and still hard-kill an agent that ignores the
 * forwarded SIGTERM.
 */
test("a one-shot host shutdown handler stays graceful and a TERM-ignoring agent is escalated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-reaper-"));
  let host: ReturnType<typeof Bun.spawn> | undefined;
  let agent = 0;
  try {
    const indexPath = join(import.meta.dir, "..", "src", "index.ts");
    const scriptPath = join(dir, "graceful.ts");
    await writeFile(scriptPath, `
import { writeFileSync } from "node:fs";
import { spawnAgentProcess } from ${JSON.stringify(indexPath)};

process.once("SIGTERM", () => writeFileSync("${dir}/handled", "1"));
void spawnAgentProcess(
  ["sh", "-lc", "echo $$ > ${dir}/agent.pid; trap '' TERM; sleep 60"],
  { timeoutMs: 60000, killGraceMs: 300 },
).then(() => writeFileSync("${dir}/returned", "1")).catch(() => undefined);
setTimeout(() => writeFileSync("${dir}/ready", "1"), 400);
setInterval(() => {}, 1000);
`);

    host = Bun.spawn(["bun", "run", scriptPath], { stdout: "pipe", stderr: "pipe" });
    await waitFor("TERM-ignoring agent to start", () => existsSync(join(dir, "ready")));
    agent = await readPid(join(dir, "agent.pid"));
    expect(pidAlive(agent)).toBe(true);

    process.kill(host.pid, "SIGTERM");
    await waitFor("one-shot shutdown handler", () => existsSync(join(dir, "handled")));
    expect(pidAlive(host.pid)).toBe(true);
    await waitFor("TERM-ignoring agent escalation", () => !pidAlive(agent));
    await waitFor("agent run to return after escalation", () => existsSync(join(dir, "returned")));
    expect(pidAlive(host.pid)).toBe(true);
  } finally {
    if (agent) {
      try {
        process.kill(-agent, "SIGKILL");
      } catch {
        // already reaped
      }
    }
    host?.kill(9);
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
