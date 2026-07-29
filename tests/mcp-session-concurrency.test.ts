import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig, type BridgeConfig, type BridgeState } from "../src/index.js";

/**
 * A stand-in `codewith` binary. It behaves like the real one on the only axis
 * this test cares about: `exec resume <id>` keeps the thread it was handed,
 * anything else forks a BRAND-NEW thread. Every invocation is logged, so the
 * assertions can see whether the second turn resumed or forked.
 */
function fakeCodewith(dir: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
log="${dir}/invocations.log"
counter="${dir}/threads"
resume=""
if [ "\${2:-}" = "resume" ]; then resume="\${3:-}"; fi
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  prev="$arg"
done
if [ -n "$resume" ]; then
  id="$resume"
else
  n=$(( $(cat "$counter" 2>/dev/null || echo 0) + 1 ))
  printf '%s' "$n" > "$counter"
  id="thread-$n"
fi
printf '%s -> %s\\n' "\${resume:-fresh}" "$id" >> "$log"
# Long enough that an unserialised second turn would overlap the first.
sleep 0.3
if [ -n "$out" ]; then printf 'reply for %s' "$id" > "$out"; fi
printf '{"type":"thread.started","thread_id":"%s"}\\n' "$id"
printf '{"type":"item.completed","item":{"type":"agent_message","text":"reply for %s"}}\\n' "$id"
`;
}

async function setupStation(): Promise<{ dir: string; configPath: string; statePath: string; binDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "bridge-mcp-turn-"));
  const binDir = join(dir, "bin");
  await mkdir(binDir, { recursive: true });
  const codewith = join(binDir, "codewith");
  await writeFile(codewith, fakeCodewith(dir), { encoding: "utf-8" });
  await chmod(codewith, 0o755);

  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  const config: BridgeConfig = {
    version: 1,
    channels: { local: { id: "local", kind: "console", enabled: true } },
    // Explicit cwd on both: keeps the run hermetic (no workspace provisioning).
    profiles: { cw: { id: "cw", agentKind: "codewith", authProfile: "test-account", cwd: dir } },
    agents: { cw: { id: "cw", kind: "codewith", profileId: "cw", cwd: dir, timeoutMs: 30_000 } },
    routes: [],
  };
  await saveConfig(config, configPath);
  return { dir, configPath, statePath, binDir };
}

/**
 * Regression, end to end through the real MCP server: two `bridge_session_send`
 * calls for ONE session.
 *
 * The MCP SDK does not serialise tool invocations, and each invocation used to
 * parse its own state snapshot around the turn. Serialising the agent run alone
 * left the queued call running against a pre-predecessor snapshot: it resumed
 * nothing, forked a SECOND codewith thread, and its trailing save clobbered the
 * thread id the first call had recorded — so the user's next message started a
 * fresh thread with no conversation context.
 *
 * The whole load -> send -> save must run inside the session turn lock.
 */
test("two concurrent bridge_session_send calls share one codewith thread", async () => {
  const { dir, configPath, statePath, binDir } = await setupStation();

  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", "src/mcp/index.ts"],
    cwd: process.cwd(),
    env: {
      PATH: `${binDir}:${process.env["PATH"] || ""}`,
      HOME: dir,
      TMPDIR: process.env["TMPDIR"] || tmpdir(),
      CODEWITH_HOME: join(dir, ".codewith"),
      BRIDGE_CONFIG: configPath,
      BRIDGE_STATE: statePath,
    },
  });
  const client = new Client({ name: "bridge-test", version: "0" });
  await client.connect(transport);

  try {
    const created = await client.callTool({ name: "bridge_session_create", arguments: { agentId: "cw" } });
    const sessionId = JSON.parse((created.content as { text: string }[])[0]!.text).id as string;

    const send = (text: string) =>
      client.callTool({ name: "bridge_session_send", arguments: { sessionId, text } });
    await Promise.all([send("first"), send("second")]);

    const invocations = (await readFile(join(dir, "invocations.log"), "utf-8")).trim().split("\n");
    expect(invocations).toHaveLength(2);
    // First turn had nothing to resume; the second resumed what it recorded.
    expect(invocations[0]).toBe("fresh -> thread-1");
    expect(invocations[1]).toBe("thread-1 -> thread-1");
    // Exactly one codewith thread was ever created for the conversation.
    expect(await readFile(join(dir, "threads"), "utf-8")).toBe("1");
    // And the persisted thread id survived the second call's save.
    const state = JSON.parse(await readFile(statePath, "utf-8")) as BridgeState;
    expect(state.sessions[sessionId]?.agentSession?.refId).toBe("thread-1");
  } finally {
    await client.close();
  }
}, 60_000);
