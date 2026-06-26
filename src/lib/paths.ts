import { join } from "node:path";

export function homeDir(): string {
  return process.env["HOME"] || process.cwd();
}

export function bridgeHome(): string {
  return process.env["BRIDGE_HOME"] || join(homeDir(), ".hasna", "bridge");
}

export function defaultConfigPath(): string {
  return process.env["BRIDGE_CONFIG"] || join(bridgeHome(), "config.json");
}
