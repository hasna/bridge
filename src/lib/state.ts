import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { bridgeHome } from "./paths.js";
import type { BridgeBinding, BridgeSession, BroadcastResult, MessageLedgerEntry } from "../types.js";

export const STATE_SCHEMA_VERSION = 2 as const;

export interface BridgeState {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  telegramOffsets: Record<string, number>;
  sessions: Record<string, BridgeSession>;
  bindings: Record<string, BridgeBinding>;
  messageLedger: Record<string, MessageLedgerEntry>;
  cursors: Record<string, string | number>;
  /** Per-post delivery reports from outbound broadcasts, keyed by broadcast id. */
  broadcasts?: Record<string, BroadcastResult>;
}

export function defaultStatePath(): string {
  return process.env["BRIDGE_STATE"] || join(bridgeHome(), "state.json");
}

export function emptyState(): BridgeState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    telegramOffsets: {},
    sessions: {},
    bindings: {},
    messageLedger: {},
    cursors: {},
    broadcasts: {},
  };
}

function normalizeState(value: Partial<BridgeState>): BridgeState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    telegramOffsets: value.telegramOffsets && typeof value.telegramOffsets === "object"
      ? value.telegramOffsets
      : {},
    sessions: value.sessions && typeof value.sessions === "object" ? value.sessions : {},
    bindings: value.bindings && typeof value.bindings === "object" ? value.bindings : {},
    messageLedger: value.messageLedger && typeof value.messageLedger === "object" ? value.messageLedger : {},
    cursors: value.cursors && typeof value.cursors === "object" ? value.cursors : {},
    broadcasts: value.broadcasts && typeof value.broadcasts === "object" ? value.broadcasts : {},
  };
}

export interface LoadStateOptions {
  /**
   * What to do when the file exists but is not parseable JSON.
   *
   * `quarantine` (default) moves the unreadable file aside and continues from
   * empty state, so a corrupt file cannot stop the bridge from starting while
   * still preserving the bytes for manual recovery. `throw` refuses to start
   * instead, for operators who would rather intervene than run with amnesia.
   */
  onCorrupt?: "quarantine" | "throw";
}

function corruptStateError(statePath: string, err: unknown): Error {
  // A bare "JSON Parse error" gives no clue which file is broken, and bridge
  // reads several JSON files on every command. Always name the file.
  return new Error(
    `Bridge state file is not valid JSON: ${statePath} (${err instanceof Error ? err.message : String(err)})`,
  );
}

export async function loadState(statePath = defaultStatePath(), options: LoadStateOptions = {}): Promise<BridgeState> {
  let raw: string;
  try {
    raw = await readFile(statePath, "utf-8");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return emptyState();
    }
    throw err;
  }

  try {
    return normalizeState(JSON.parse(raw) as Partial<BridgeState>);
  } catch (err) {
    if (options.onCorrupt === "throw") throw corruptStateError(statePath, err);
    // Move the unreadable file aside rather than overwriting it: it is the only
    // copy of the sessions, bindings and delivery ledger, so it must survive
    // long enough for a human to salvage.
    const quarantine = `${statePath}.corrupt-${Date.now()}`;
    await rename(statePath, quarantine);
    await chmod(quarantine, 0o600).catch(() => undefined);
    console.error(`${corruptStateError(statePath, err).message}; moved aside to ${quarantine} and continuing from empty state`);
    return emptyState();
  }
}

export async function saveState(state: BridgeState | Partial<BridgeState>, statePath = defaultStatePath()): Promise<void> {
  const normalized = normalizeState(state);
  const dir = dirname(statePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Write to a private temp file, flush it, then rename over the target. The
  // daemon rewrites state on every poll while CLI commands read the same file:
  // an in-place write lets a reader observe a half-written document, and a crash
  // mid-write leaves a truncated state.json that the daemon can never load.
  // randomUUID, not pid+timestamp: concurrent saves in one process would
  // otherwise be able to pick the same temp name and clobber each other.
  const tmp = join(dir, `.${basename(statePath)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
      // Flush before the rename so the replacement can never expose a file whose
      // contents have not reached the disk.
      await handle.sync().catch(() => undefined);
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    await rename(tmp, statePath);
    await syncDir(dir);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Make the rename itself durable. Best effort: not every filesystem allows it. */
async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is unsupported here; the atomic rename still holds.
  }
}
