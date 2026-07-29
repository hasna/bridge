import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAgentSpawn, spawnAgentProcess } from "../src/index.js";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Regression: the run timeout must actually bound the call.
 *
 * The previous implementation raced `subprocess.exited` against a timer, sent a
 * single SIGTERM to the direct child only, and THEN awaited
 * `new Response(child.stdout).text()`. Any process still holding the stdout pipe
 * open — a SIGTERM-ignoring agent, or (far more common for a full-YOLO codewith
 * run) a background process the agent itself started — kept that read pending
 * forever. Because the serve loop awaits this call for every inbound message,
 * one such run wedged the whole bridge: no message on any channel was ever
 * processed again.
 */
test("defaultAgentSpawn returns on timeout even when the child ignores SIGTERM and a grandchild holds the pipe", async () => {
  const started = Date.now();
  const result = await defaultAgentSpawn(
    // Ignores SIGTERM, and leaves a background child inheriting stdout.
    ["sh", "-lc", "trap '' TERM; sleep 60 & echo working; sleep 60"],
    { timeoutMs: 300 },
  );
  const elapsed = Date.now() - started;

  expect(result.timedOut).toBe(true);
  // Bounded: timeout + at most the kill grace, never unbounded.
  expect(elapsed).toBeLessThan(15_000);
  // Output captured before the kill is still returned.
  expect(result.stdout).toContain("working");
}, 20_000);

/**
 * Regression: a timed-out run must not leave orphaned processes behind. The old
 * code killed only the direct child, so every tool/shell the agent had spawned
 * survived the timeout and accumulated on the station across runs.
 */
test("a timed-out run kills the agent's whole process tree, not just the direct child", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-spawn-"));
  const pidFile = join(dir, "grandchild.pid");
  try {
    const result = await spawnAgentProcess(
      ["sh", "-lc", `trap '' TERM; sleep 60 & echo $! > ${pidFile}; sleep 60`],
      { timeoutMs: 300, killGraceMs: 400 },
    );
    expect(result.timedOut).toBe(true);

    const grandchild = Number.parseInt((await readFile(pidFile, "utf-8")).trim(), 10);
    expect(Number.isInteger(grandchild)).toBe(true);
    expect(pidAlive(grandchild)).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

/**
 * Regression: captured output was unbounded. A long full-YOLO codewith run emits
 * a `--json` event per tool call, so a single turn can produce hundreds of
 * megabytes; the old code buffered all of it (and `extractCodewith*` then split
 * the whole blob again), which is an OOM of the bridge daemon.
 *
 * The cap keeps the HEAD and the TAIL, because both carry meaning for codewith
 * JSONL: `thread.started` (the session id) is emitted first and the final
 * assistant message last.
 */
test("subprocess output is capped, retaining the head and the tail of the stream", async () => {
  const result = await spawnAgentProcess(
    ["sh", "-lc", "echo HEADMARKER; head -c 200000 /dev/zero | tr '\\0' 'x'; echo; echo TAILMARKER"],
    { timeoutMs: 15_000, maxOutputBytes: 4_000 },
  );

  expect(result.timedOut).toBe(false);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.length).toBeLessThan(10_000);
  expect(result.stdout).toContain("HEADMARKER");
  expect(result.stdout).toContain("TAILMARKER");
  expect(result.stdout).toContain("omitted");
}, 20_000);

test("a normal run still returns full output and the real exit code", async () => {
  const ok = await spawnAgentProcess(["sh", "-lc", "echo out; echo err 1>&2; exit 0"], { timeoutMs: 10_000 });
  expect(ok.exitCode).toBe(0);
  expect(ok.timedOut).toBe(false);
  expect(ok.stdout.trim()).toBe("out");
  expect(ok.stderr.trim()).toBe("err");

  const failed = await spawnAgentProcess(["sh", "-lc", "exit 3"], { timeoutMs: 10_000 });
  expect(failed.exitCode).toBe(3);
  expect(failed.timedOut).toBe(false);
}, 20_000);

/**
 * A process killed by a signal must NOT look like a clean exit: `exitCode` is
 * reported as the shell-convention 128+signal so the caller's
 * `exitCode !== 0` failure check fires instead of silently treating an
 * OOM-killed agent as a successful run with no output.
 */
test("a signal-killed agent reports a non-zero exit code, not a clean one", async () => {
  const result = await spawnAgentProcess(["sh", "-lc", "kill -9 $$"], { timeoutMs: 10_000 });
  expect(result.timedOut).toBe(false);
  expect(result.exitCode).not.toBe(0);
  expect(result.exitCode).not.toBeNull();
}, 20_000);

test("spawning a missing binary rejects instead of returning a fake successful run", async () => {
  await expect(
    spawnAgentProcess(["bridge-definitely-not-a-real-binary-xyz"], { timeoutMs: 5_000 }),
  ).rejects.toThrow();
}, 20_000);
