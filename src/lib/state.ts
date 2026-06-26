import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { bridgeHome } from "./paths.js";
import type { BridgeBinding, BridgeSession, MessageLedgerEntry } from "../types.js";

export const STATE_SCHEMA_VERSION = 2 as const;

export interface BridgeState {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  telegramOffsets: Record<string, number>;
  sessions: Record<string, BridgeSession>;
  bindings: Record<string, BridgeBinding>;
  messageLedger: Record<string, MessageLedgerEntry>;
  cursors: Record<string, string | number>;
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
  };
}

export async function loadState(statePath = defaultStatePath()): Promise<BridgeState> {
  try {
    const raw = await readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<BridgeState>;
    return normalizeState(parsed);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return emptyState();
    }
    throw err;
  }
}

export async function saveState(state: BridgeState | Partial<BridgeState>, statePath = defaultStatePath()): Promise<void> {
  const normalized = normalizeState(state);
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await writeFile(statePath, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  await chmod(statePath, 0o600);
}
