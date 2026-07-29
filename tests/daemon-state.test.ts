import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emptyState, loadState, saveState, type BridgeState } from "../src/index.js";

// ─── Defect: state writes are not atomic ─────────────────────────────────────

// The bridge daemon rewrites state on every poll while CLI commands read and
// write the same file. A reader that opens the file must always observe a whole
// JSON document, which only holds if writes replace the file atomically.
test("state writes replace the file atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-state-"));
  const statePath = join(dir, "state.json");
  const state: BridgeState = emptyState();
  state.cursors["a"] = "1";
  await saveState(state, statePath);

  const before = await stat(statePath);
  const reader = await open(statePath, "r");
  try {
    const bigger: BridgeState = emptyState();
    for (let i = 0; i < 5000; i++) bigger.cursors[`k${i}`] = "x".repeat(200);
    await saveState(bigger, statePath);

    // The handle opened before the write must still see the complete previous
    // document, not a truncated one.
    const held = await reader.readFile("utf-8");
    expect(() => JSON.parse(held)).not.toThrow();
    expect(JSON.parse(held).cursors.a).toBe("1");

    const after = await stat(statePath);
    expect(after.ino).not.toBe(before.ino);
  } finally {
    await reader.close();
  }
});

// Note: this does not prove the fsync reached the platter (that needs a crashing
// kernel). It proves the completed write is visible, private, and temp-file free
// across a process boundary.
test("state written by another process is complete, private, and leaves no temp file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-state-"));
  const statePath = join(dir, "state.json");
  const state = emptyState();
  state.cursors["durable"] = "yes";

  const proc = Bun.spawn([
    "bun",
    "-e",
    `const { saveState } = await import(${JSON.stringify(join(process.cwd(), "src/index.ts"))});` +
    `await saveState(${JSON.stringify(state)}, ${JSON.stringify(statePath)});`,
  ], { stdout: "ignore", stderr: "pipe" });
  expect(await proc.exited).toBe(0);

  expect((await loadState(statePath)).cursors["durable"]).toBe("yes");
  expect((await stat(statePath)).mode & 0o777).toBe(0o600);
  expect(await readdir(dir)).toEqual(["state.json"]);
});

test("atomic state writes leave no temp files behind and keep mode 0600", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-state-"));
  const statePath = join(dir, "state.json");
  await saveState(emptyState(), statePath);
  await chmod(statePath, 0o644);
  await saveState(emptyState(), statePath);

  expect((await stat(statePath)).mode & 0o777).toBe(0o600);
  expect(await readdir(dir)).toEqual(["state.json"]);
});

// ─── Defect: a corrupt state file bricks the daemon until a human deletes it ──

// A truncated state.json made `loadState` throw on every start, so the daemon
// could not boot at all. Recovery must not require a human, and must not destroy
// the bad file (it is the only copy of the sessions/bindings/ledger).
test("loadState quarantines a corrupt state file and boots from empty state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-state-"));
  const statePath = join(dir, "state.json");
  await writeFile(statePath, '{"schemaVersion": 2, "sessions": {', { mode: 0o600 });

  const state = await loadState(statePath);
  expect(state).toEqual(emptyState());

  const quarantined = (await readdir(dir)).filter((name) => name !== "state.json");
  expect(quarantined.length).toBe(1);
  expect(quarantined[0]).toStartWith("state.json.corrupt-");
  // The unreadable bytes are preserved for manual recovery, not deleted.
  expect(await Bun.file(join(dir, quarantined[0]!)).text()).toBe('{"schemaVersion": 2, "sessions": {');
  expect((await stat(join(dir, quarantined[0]!))).mode & 0o777).toBe(0o600);

  // The bridge can now write state normally over the quarantined original.
  await saveState(state, statePath);
  expect(await loadState(statePath)).toEqual(emptyState());
});

test("loadState can be asked to fail loudly instead of quarantining", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-state-"));
  const statePath = join(dir, "state.json");
  await writeFile(statePath, "not json at all", { mode: 0o600 });

  await expect(loadState(statePath, { onCorrupt: "throw" })).rejects.toThrow(statePath);
  // Nothing was moved aside.
  expect(await readdir(dir)).toEqual(["state.json"]);
});

test("loadState still surfaces non-ENOENT filesystem errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-state-"));
  const statePath = join(dir, "state.json");
  await mkdir(statePath);
  await expect(loadState(statePath)).rejects.toThrow();
  await rm(statePath, { recursive: true, force: true });
});
