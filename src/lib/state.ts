import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { bridgeHome } from "./paths.js";

export interface BridgeState {
  telegramOffsets: Record<string, number>;
}

export function defaultStatePath(): string {
  return process.env["BRIDGE_STATE"] || join(bridgeHome(), "state.json");
}

export function emptyState(): BridgeState {
  return { telegramOffsets: {} };
}

export async function loadState(statePath = defaultStatePath()): Promise<BridgeState> {
  try {
    const raw = await readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<BridgeState>;
    return {
      telegramOffsets: parsed.telegramOffsets && typeof parsed.telegramOffsets === "object"
        ? parsed.telegramOffsets
        : {},
    };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return emptyState();
    }
    throw err;
  }
}

export async function saveState(state: BridgeState, statePath = defaultStatePath()): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  await chmod(statePath, 0o600);
}
