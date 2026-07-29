import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  // A login shell sources the host's profile and can add unrelated diagnostics
  // to stderr, making this subprocess contract test depend on ambient dotfiles.
  const ok = await spawnAgentProcess(["sh", "-c", "echo out; echo err 1>&2; exit 0"], { timeoutMs: 10_000 });
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

/**
 * Regression: a COMPLETED run must not be reported as a timeout.
 *
 * `close` needs the process to exit AND its pipes to drain, and anything the
 * agent leaves behind (`bun run dev &`, a watcher) inherits stdout and holds
 * them open. The first version of this fix hardcoded `timedOut: true` on the
 * give-up path, discarding the exit code the `exit` handler had already
 * captured. Downstream that becomes status `failed`, which is NOT a terminal
 * ledger status, so one user message was re-run up to DEFAULT_MAX_ATTEMPTS
 * times — five real agent runs appending five duplicate turns to the same
 * codewith thread — before the user got their correct answer wrapped in
 * "⚠️ I could not process that message (5 attempts)".
 */
test("a finished run is not reported as a timeout just because a leftover process holds the pipe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-spawn-"));
  const pidFile = join(dir, "holder.pid");
  let holder = 0;
  try {
    const result = await spawnAgentProcess(
      ["sh", "-lc", `sleep 20 & echo $! > ${pidFile}; echo "the answer"; exit 0`],
      { timeoutMs: 400, killGraceMs: 300 },
    );

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("the answer");

    // The run succeeded, so its leftover background process is left alone —
    // killing the group here would take down exactly the dev server or watcher
    // the agent was asked to start.
    holder = Number.parseInt((await readFile(pidFile, "utf-8")).trim(), 10);
    expect(pidAlive(holder)).toBe(true);
  } finally {
    if (holder) {
      try {
        process.kill(holder, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

/**
 * Regression: the HOST process must still be able to exit.
 *
 * On any path where `close` never fires, the ChildProcess stdio handles stay
 * referenced by the event loop, so the host hangs forever even after
 * `spawnAgentProcess` has correctly returned. A one-shot `bridge send` printed
 * its result and then blocked indefinitely — fatal for a scripted or CI caller —
 * and `serve` could never terminate normally, which also meant the exit-time
 * agent reaper could never run.
 */
test("the host process exits naturally after a run whose pipes are still held open", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-hostexit-"));
  const holderPidFile = join(dir, "holder.pid");
  let holder = 0;
  try {
    const indexPath = join(import.meta.dir, "..", "src", "index.ts");
    const scriptPath = join(dir, "host.ts");
    // The pipe holder must outlive the whole measurement window: without the
    // stream release the host hangs until the holder exits, so a short-lived
    // holder would let a broken build pass by exiting first.
    await writeFile(
      scriptPath,
      [
        `import { spawnAgentProcess } from ${JSON.stringify(indexPath)};`,
        `const r = await spawnAgentProcess(["sh", "-lc", ${JSON.stringify(`sleep 20 & echo $! > ${holderPidFile}; echo done`)}], { timeoutMs: 400, killGraceMs: 300 });`,
        `console.log("RESULT", r.timedOut, r.stdout.trim());`,
      ].join("\n"),
    );

    const host = Bun.spawn(["bun", "run", scriptPath], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await Promise.race([
      host.exited,
      new Promise<"HUNG">((resolve) => setTimeout(() => resolve("HUNG"), 12_000)),
    ]);
    const stdout = await new Response(host.stdout).text();
    if (exitCode === "HUNG") host.kill(9);

    expect(stdout).toContain("RESULT");
    expect(exitCode).toBe(0);

    holder = Number.parseInt((await readFile(holderPidFile, "utf-8")).trim(), 10);
  } finally {
    if (holder) {
      try {
        process.kill(holder, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

/**
 * Regression: head and tail were decoded as separate buffers, so a multi-byte
 * UTF-8 character straddling the internal seam was corrupted into replacement
 * characters even when NOTHING was dropped.
 */
test("a multi-byte character straddling the capture seam is not corrupted", async () => {
  // 9 ASCII bytes, then é as its two raw bytes (0xC3 0xA9), then X: 12 bytes
  // total. With a 20-byte cap the seam falls at byte 10 — mid-character — and
  // nothing is dropped.
  const result = await spawnAgentProcess(
    ["sh", "-lc", "printf 'aaaaaaaaa\\303\\251X'"],
    { timeoutMs: 10_000, maxOutputBytes: 20 },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("aaaaaaaaaéX");
  expect(result.stdout).not.toContain("�");
  expect(result.stdout).not.toContain("omitted");
}, 20_000);
