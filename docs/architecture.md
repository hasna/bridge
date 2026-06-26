# Bridge Architecture

`bridge` separates channel connectors from agent adapters. In `0.2.x`, the
primary product model is session-backed routing: external conversations bind to
durable bridge sessions, and bridge sessions bind to agent sessions.

Channels own external transport details such as Telegram bot tokens, chat IDs,
webhooks, or iMessage transport. Agents own local execution details such as
Codewith auth profiles, Claude profile homes, AIcopilot state roots, cwd, and
environment. Bindings connect a channel conversation to a durable bridge
session. Routes remain a compatibility surface for explicit stateless tests.

The package deliberately keeps Telegram-specific or iMessage-specific behavior
out of Codewith, Claude, and AIcopilot integrations. Agent adapters receive
normalized session messages and return final responses or stream events. Channel
connectors decide how to receive, authorize, normalize, and deliver messages.

## Data Model

- `channels`: external message transports.
- `profiles`: reusable identity/state settings for an agent family.
- `agents`: runnable targets, usually pointing at one profile.
- `sessions`: bridge-owned conversations with one agent target and optional
  external agent session reference.
- `bindings`: mapping from normalized external conversation IDs to active
  bridge sessions.
- `messageLedger`: idempotency and retry records for inbound channel messages.
- `cursors`: per-channel offsets committed after terminal processing.
- `routes`: compatibility mapping rules from channel messages to agents.

Runtime state uses `schemaVersion: 2` and is backward-compatible with the
`0.1.x` state shape that only stored `telegramOffsets`.

## Profile Model

Codewith profiles use `authProfile`. The durable adapter should use Codewith's
background-agent surface where a noninteractive create/send/resume flow is
available. `codewith --auth-profile <name> --cd <cwd> exec <prompt>` is
compatibility mode because it is a one-shot process and does not preserve
agent-side conversation context.

Claude profiles can use `home` or custom env vars so multiple accounts do not
share local state.

AIcopilot profiles currently use cwd/env/command isolation. The adapter must add
or consume first-class create/send/events session support before AIcopilot can
be presented as a durable bridge session target.

## Telegram

The first connector uses Telegram Bot API `getUpdates` long polling and
`sendMessage`. Production deployments should move high-volume bots to webhooks,
but long polling is the right baseline for local agent machines and early
testing.

Telegram channels fail closed unless `allowedChatIds` are configured or
`allowAllChats` is explicitly enabled. Channel `allowedChatIds` are enforced
before route matching. Routes can also add narrower `match.chatIds` filters, but
they cannot expand beyond the channel allowlist.

Disabled channels do not match inbound routes and do not deliver responses.
MCP config inspection redacts profile and agent environment values so local
secrets are not exposed through `bridge_config`.

Long-poll offsets are persisted in a private state file so process restarts do
not replay already-seen terminal updates and re-run agents. In session mode,
offsets must be committed only after the inbound message reaches a terminal
ledger state: delivered, intentionally skipped, or unauthorized. Failed
messages remain retryable and do not advance the Telegram offset.

If the agent succeeds and outbound delivery fails, the ledger stores the final
response in `agent_completed`; retry attempts deliver the stored response rather
than invoking the agent again.

When a Telegram chat has an active binding, plain text routes to that session.
When no binding exists, the bridge can reply with setup instructions and does
not invoke an agent. Route matching is still available as compatibility fallback
for explicit configured routes.

Telegram forum topics are part of the normalized conversation ID:
`telegram:<channelId>:<chatId>:<messageThreadId>`.

`BRIDGE_TELEGRAM_API_BASE` can override the Telegram API origin for local tests.
The override accepts only `http` or `https` URLs without credentials. It is not
intended for normal production use because bot tokens are part of Telegram API
request paths.

## Daemon Model

The foreground runtime remains `bridge serve`. Daemon commands are lifecycle
wrappers around that same runtime:

- `bridge daemon start` uses a local process supervisor by default.
- `bridge daemon status` reads private metadata and verifies the recorded
  process still looks like `bridge serve`.
- `bridge daemon stop` terminates the process group and removes stale metadata.
- `bridge daemon logs` reads private stdout/stderr logs.
- `bridge daemon install` writes user `launchd` or user `systemd` files.

The process supervisor is the quickest local testing path because it inherits
the shell environment, including Telegram token env vars. Installed launchd and
systemd services do not store token values by default; operators must make token
env vars available through their service manager.

Daemon files live under `~/.hasna/bridge/daemon` by default. The directory is
`0700`; metadata and log files are `0600`. Logs are considered sensitive because
they can contain prompts, Telegram text, agent stdout/stderr, and routing
errors.

`bridge serve` handles per-channel poll errors without exiting in long-running
mode. `serve --once` still fails fast so health checks and tests can catch
misconfiguration.

## iMessage

iMessage support is local macOS-only. The adapter must send through Messages
automation and receive through local Messages state or a documented helper mode.
It must fail closed when Automation or Full Disk Access permissions are missing.
Diagnostics should report the missing permission without reading or logging
private message contents unnecessarily.

The implemented adapter sends with `osascript` and can optionally receive by
polling `~/Library/Messages/chat.db` when `receiveMode` is `chat-db`. The send
script honors `account` when configured. The receive path filters out messages
from the local user, enforces `allowedHandles` unless `allowAllHandles` is
explicitly set, scans ahead past disallowed rows to avoid cursor starvation, and
keeps local Messages chat GUIDs so group chats do not collapse to a single
sender handle. Daemon cursors store the last processed Messages row ID per
channel.

## MCP

MCP must expose session-first tools for listing, creating, attaching, sending
to, and inspecting bridge sessions. Route-based MCP tools are compatibility-only
after `0.2.x`; MCP clients should use `bridge_session_route_message` when they
want normal inbound message behavior through bindings.
