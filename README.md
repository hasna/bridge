# bridge

`bridge` connects local coding agents to Telegram, iMessage, and local console
channels. It provides durable per-conversation sessions, compatibility routes,
background polling, outbound broadcasts, and an MCP server. The npm package is
`@hasna/bridge`; the installed binaries are `bridge` and `bridge-mcp`.

## Requirements

- [Bun](https://bun.sh/) 1.0 or newer.
- The CLI for each configured agent kind (`codewith`, `claude`, or
  `aicopilot`). Shell agents use `sh`.
- macOS, Messages, and the required Automation/Full Disk Access permissions for
  iMessage.

## Install

```sh
bun install -g @hasna/bridge
bridge --version
```

## Quick Start

Create a Telegram bot with BotFather, export its token, and configure an
allowlisted chat:

```sh
export TELEGRAM_BOT_TOKEN='123456:...'

bridge init
bridge channels add-telegram telegram-main \
  --token-env TELEGRAM_BOT_TOKEN \
  --allowed-chat-ids CHAT_ID \
  --default-chat-id CHAT_ID \
  --default-agent codewith
bridge profiles add codewith-main \
  --agent-kind codewith \
  --auth-profile account001
bridge agents add codewith --kind codewith --profile codewith-main
bridge doctor
bridge serve
```

The first authorized message in a conversation creates a bridge session and
binding for the channel's `defaultAgentId`. If no default is set, bridge uses
the only configured `codewith` agent; it does not guess when several codewith
agents exist. Later messages resume the same durable session.

Use `bridge daemon start` instead of `bridge serve` to poll in the background.

## Routing Model

Inbound messages follow this order:

1. Reject disabled channels and senders outside the channel allowlist.
2. Resume the session already bound to the normalized conversation.
3. If no binding exists, create one for `defaultAgentId`, or for the sole
   configured codewith agent.
4. If no agent can be selected, try matching compatibility routes when serving
   or when `sessions route-message --fallback-routes` is requested.
5. Otherwise return session setup instructions without invoking an agent.

Telegram forum topics have independent conversation IDs. iMessage group chats
use their local Messages chat GUID so replies return to the group rather than
only to the sender.

Sessions can also be managed explicitly:

```sh
bridge sessions list
bridge sessions show SESSION_ID
bridge sessions create --agent codewith --cwd /repo
bridge sessions attach SESSION_ID --channel telegram-main --conversation CHAT_ID
bridge sessions use SESSION_ID --channel telegram-main --conversation CHAT_ID
bridge sessions detach --channel telegram-main --conversation CHAT_ID
bridge sessions pause SESSION_ID
bridge sessions resume SESSION_ID
bridge sessions close SESSION_ID
bridge sessions send SESSION_ID "status"
```

`pause`, `resume`, and `close` update bridge-owned state. Compatibility adapters
do not expose provider-side resume or cancellation; only the durable codewith
adapter persists and resumes a provider thread.

## Agents And Profiles

Profiles hold reusable account and execution settings. Agents select a profile
and may override its command, arguments, cwd, environment, or timeout.

```sh
bridge profiles add cw-primary \
  --agent-kind codewith \
  --auth-profile account001
bridge profiles add cw-fallback \
  --agent-kind codewith \
  --auth-profile account002
bridge agents add codewith \
  --kind codewith \
  --profile cw-primary \
  --fallback-profile cw-fallback
```

Durable codewith sessions run `codewith exec --json --durable` directly against
one shared `CODEWITH_HOME`. On a structured usage, quota, or authentication
exhaustion error, bridge tries each configured fallback profile at most once and
resumes the same thread under the next billing account. A missing or expired
thread is retried once as a fresh session and the user is told that prior context
was not carried over.

Bridge codewith runs include `--skip-git-repo-check` and
`--dangerously-bypass-approvals-and-sandbox`. They are intentionally
unsandboxed and can write or execute anywhere available to the bridge process.
Only configure agents and channels you trust.

When no explicit session, agent, or profile cwd is configured, CLI `ask` and
`serve` lazily provision an `agent-<name>` project directory and conversations
channel. The default project root is
`~/workspace/hasnaxyz/agent`; set `BRIDGE_AGENT_WORKSPACE_ROOT` to override it.
Provisioning failures do not block an agent run and are retried later.

Spawned agents do not inherit the whole bridge environment. Bridge passes a
small runtime/toolchain allowlist, strips bridge channel secrets and
credential-shaped variables, then applies explicit profile and agent `env`
values. Advanced `envPassthrough` entries can be configured in JSON as exact
names or `PREFIX*` globs.

Claude and AIcopilot adapters currently run one CLI process per message and are
recorded as compatibility sessions. A custom `command` also selects
compatibility mode.

## Channels

### Telegram

Telegram uses Bot API `getUpdates` long polling and `sendMessage`. Inbound and
direct outbound messaging fail closed unless the chat is in `allowedChatIds` or
`allowAllChats` is true. Routes may narrow that allowlist but cannot expand it.
The optional `BRIDGE_TELEGRAM_API_BASE` override accepts only credential-free
HTTP(S) URLs without query strings or fragments.

```sh
bridge send telegram-main CHAT_ID "hello"
bridge route-message --channel telegram-main --chat-id CHAT_ID --text "status" --json
bridge sessions route-message --channel telegram-main --chat-id CHAT_ID --text "status" --json
```

### iMessage

iMessage sending uses Messages automation through `osascript`. Optional receive
mode polls `~/Library/Messages/chat.db`, ignores messages sent by the local user,
and filters by handle, account, and service before advancing a per-channel row
cursor.

```sh
bridge channels add-imessage imessage-main \
  --allowed-handles +15555550100 \
  --default-handle +15555550100
bridge send imessage-main "hello"
```

Add `--receive` to enable database polling. Grant Full Disk Access to the
terminal or service host if `bridge doctor` reports that `chat.db` is
inaccessible. Use `--account` on multi-account Macs.

### Console

Console channels are useful for local sends, route probes, and broadcasts:

```sh
bridge channels add-console local
bridge send local "hello"
bridge broadcast local "release complete"
```

Webhook configuration is accepted by the library schema, but no webhook CLI,
receiver, sender, or daemon poller is implemented yet.

## Delivery And Recovery

Runtime state includes sessions, bindings, channel cursors, broadcasts, and a
message ledger. Bridge persists an inbound ledger entry before running an agent.
Processing failures leave the cursor in place for retry. After five processing
attempts by default, the message becomes `dead_letter`, the cursor advances, and
bridge tries to send the user a clear failure reply.

If the agent completes but sending its reply fails, bridge stores the response
as `agent_completed` and retries delivery without rerunning the agent. Delivery
has a separate ten-attempt budget; exhausting it advances the cursor but retains
the answer and records an operator-facing error.

Terminal ledger states are `delivered`, `skipped`, `unauthorized`, and
`dead_letter`. `bridge serve --resume` reconciles interrupted state before
polling. Process daemons enable resume by default; use `--no-resume` to opt out.

## Broadcasts

Telegram broadcasts use a separate outbound allowlist: `broadcastChatIds` or
`allowAllBroadcasts`. Explicit `--targets` values still must pass that allowlist.
Console broadcasts write one local post. iMessage and webhook broadcasts are not
implemented.

```sh
bridge channels add-telegram announce \
  --allowed-chat-ids CHAT_ID \
  --broadcast-chat-ids -1002001,-1002002
bridge broadcast announce "release v1.2.3 is live" --json
bridge broadcasts list
bridge broadcasts show BROADCAST_ID
```

Reports record each target as `sent`, `failed`, or `skipped` and retain the most
recent 200 broadcasts in state. The CLI exits non-zero when any target failed;
use `--no-record` to skip persistence.

## Daemon

```sh
bridge daemon start
bridge daemon status
bridge daemon logs --lines 100
bridge daemon restart
bridge daemon stop
```

The default process supervisor inherits the current environment and stores
private metadata and logs under `~/.hasna/bridge/daemon`. For login-managed
services, `daemon install/start/stop/uninstall --supervisor auto` selects a user
launchd service on macOS or systemd service on Linux. Supervisor files do not
contain Telegram token values; import those variables into the service manager
before starting.

## MCP

`bridge-mcp` is a stdio MCP server exposing:

- `bridge_status` and redacted `bridge_config`
- `bridge_session_list`, `bridge_session_status`, `bridge_session_create`,
  `bridge_session_attach`, `bridge_session_send`, and
  `bridge_session_route_message`
- compatibility `bridge_route_message`
- `bridge_broadcast` and `bridge_broadcast_reports`

MCP tools use the default config and state paths. `bridge_session_send` invokes
the agent but has no external response channel; inspect its structured result.

## Files And Environment

Defaults:

- Config: `~/.hasna/bridge/config.json` (`0600`)
- State: `~/.hasna/bridge/state.json` (`0600`)
- Daemon directory: `~/.hasna/bridge/daemon` (`0700`)
- Daemon metadata and logs: `0600`

Set `BRIDGE_HOME` to move all defaults, or override config and state separately
with `BRIDGE_CONFIG` and `BRIDGE_STATE`. `BRIDGE_DEBUG` prints action-handler
stack traces after the normal one-line CLI error.

Config stores Telegram token environment variable names, not token values.
Treat state and logs as sensitive because they contain prompts, responses,
session references, delivery reports, and routing errors.

See [`docs/architecture.md`](docs/architecture.md) for the runtime design. The
historical implementation plan is retained in
[`docs/session-bridge-plan.md`](docs/session-bridge-plan.md).
