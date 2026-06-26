# Session-Backed Multi-Channel Bridge Plan

This is the working plan for the `0.2.x` bridge release. The repo folder is
`open-bridge`, the package is `@hasna/bridge`, and the CLI remains `bridge`.

## Goal

`bridge` should connect external conversations to durable agent sessions. A
Telegram chat, iMessage thread, Slack channel, or future channel should map to a
bridge conversation and then to a Codewith, Claude Code, or AIcopilot session.
Normal messages go to the active bound session. Prefixes are only acceptable as
an optional compatibility route, not as the main product model.

## Target Model

```text
channel event
  -> normalized bridge conversation
  -> durable bridge binding
  -> agent session adapter
  -> streamed or final channel response
```

- Channels normalize inbound events and deliver outbound text.
- Bindings map external conversation IDs to bridge sessions.
- Agent adapters own account/profile state and send messages to a durable agent
  session.
- Session commands manage control flow; ordinary text is user intent.

## Versioned State

`0.2.x` must add versioned state separate from static config:

- `schemaVersion`: state schema version with forward-only migration.
- `sessions`: bridge-owned session records keyed by stable session ID.
- `bindings`: external conversation bindings keyed by normalized channel
  conversation ID.
- `messageLedger`: per-channel inbound processing records for idempotency,
  retries, and delivery status.
- `cursors`: per-channel cursor/offset state, committed only after the inbound
  message has reached a terminal routing state.

Session records must include agent ID, profile ID, cwd, status
(`active`, `paused`, `closed`), external agent session reference, timestamps,
last activity, timeout policy, and compatibility-mode marker when an adapter
falls back to one-shot execution.

Binding records must include channel ID, normalized conversation ID, active
session ID, optional default session ID, created/updated timestamps, and an
authorization snapshot such as Telegram chat ID or iMessage handle.

## Idempotency And Retry

- Inbound message processing writes a ledger row before invoking an agent.
- Channel cursors advance only after a message is delivered, intentionally
  skipped, or rejected as unauthorized. Failed messages remain retryable until a
  retry-exhaustion policy is added.
- Agent failure leaves a retryable `failed` ledger state.
- Outbound send failure after an agent succeeds leaves an `agent_completed`
  ledger state with the generated response, so retries do not re-run the agent.
- Replayed updates must not run the agent twice after a successful delivery.
- Daemon restart must recover in-progress ledger rows without losing prompts.

## Commands

Planned CLI surface:

```sh
bridge sessions list
bridge sessions show <id>
bridge sessions create --agent codewith --cwd /repo
bridge sessions attach <id> --channel telegram-main --conversation 1225577096
bridge sessions use <id> --channel telegram-main --conversation 1225577096
bridge sessions detach --channel telegram-main --conversation 1225577096
bridge sessions close <id>
bridge sessions pause <id>
bridge sessions resume <id>
```

Telegram and future command-capable channels should expose the same session
controls as slash commands:

```text
/sessions
/new
/use <id>
/attach <id>
/detach
/pause
/resume
/close
/help
```

## Channels

Telegram:

- Plain messages route to the active session for that chat.
- If no active session exists, the bot responds with a short setup prompt and
  does not invoke an agent.
- Slash commands manage sessions and never require a `cw` prefix.
- Group chats must support `/command@BotName`, topic/thread IDs when Telegram
  provides them, and unauthorized command rejection.
- Unknown slash commands are treated as control errors, not agent prompts.
- A literal agent prompt that starts with `/` must require an explicit escape
  command or compatibility route, so control messages and prompts do not collide.
- Existing route-based behavior can remain for explicit compatibility tests.

iMessage:

- The first adapter is local macOS-only.
- Sending uses Messages automation through `osascript` and reports TCC
  Automation failures clearly.
- Receiving uses local Messages state with a per-chat cursor or a documented
  helper mode. It must fail closed when Full Disk Access or Messages data access
  is unavailable.
- Conversation IDs are normalized from service, chat GUID, handle, and optional
  account so multiple local accounts do not collide.
- Permission diagnostics explain needed macOS Automation and Full Disk Access
  grants without storing private message contents in config.
- Tests must be skip-safe on non-macOS and on macOS machines without the needed
  permissions.
- The current implementation supports send through `osascript` and optional
  receive through `chat.db` polling when `receiveMode` is `chat-db`.

## Channel Adapter Contract

Each channel adapter must provide:

- `poll` or `receive` with a cursor and bounded batch size.
- `send` with normalized conversation ID and delivery result.
- `diagnose` for auth, permissions, and environment checks.
- Per-channel backoff hints for daemon runtime.
- Redaction rules for sensitive channel metadata and message contents.

## Agents

Codewith:

- Use a stable local session API or mailbox-backed background session.
- Use auth profiles explicitly, for example `account001`.
- Avoid typing into the interactive TUI as the primary integration method.

Claude Code:

- Use the official resumable/session surface where available.
- Keep account homes/profiles isolated.
- Mark any process-wrapper fallback clearly as compatibility mode and do not
  advertise it as a durable session.

AIcopilot:

- Use the same session contract as Codewith where possible.
- Add create/send/events semantics if the repo does not expose them yet.

## Agent Adapter Contract

Each agent adapter must provide:

- `createSession(profile, cwd, options) -> agentSessionRef`.
- `sendMessage(sessionRef, text, options) -> final response or stream events`.
- `resumeSession(sessionRef)` after daemon restart.
- `cancel(sessionRef)` where the underlying agent supports cancellation.
- `close(sessionRef)` for local cleanup.
- Explicit timeout, output limit, stderr, and compatibility-mode behavior.

## Tracked Tasks

The local `todos` plan is `cba73b38-97c5-4a02-bf58-1a03069cc0c4`:

- `4e73f3bf-3fbb-4aae-8d01-045501db925d`: define durable bridge session model.
- `630b62e3-6d57-4121-b3de-90052ad21f66`: add session CLI and persistent bindings.
- `e5820e95-3c91-4523-a583-84bb4b1e7a56`: implement session-aware agent adapters.
- `56906077-0fdb-4767-bdd0-a1990508eade`: make Telegram work without prefixes.
- `a93e4741-529e-4718-a6c9-f8ed213756db`: add macOS iMessage channel adapter.
- `54698f24-7a62-4f02-9dba-4095194adc59`: release, reinstall, and verify bridge 0.2.
- `e268d9a7-ac40-4df9-9cfb-8e820795d87a`: adversarially verify the release.

## Done Criteria

- `bun run build`, `bun run typecheck`, and `bun test` pass.
- Session bindings survive daemon restarts.
- Telegram live test works with plain messages against the configured bot.
- iMessage diagnostics and send/receive smoke behavior work on macOS or fail
  closed with a clear permission result.
- The package is committed, pushed, published, reinstalled locally, and smoke
  tested from the public npm package.
- An adversarial review checks routing security, secret handling, daemon
  lifecycle, replay/idempotency, channel spoofing, and package installability.

## MCP Migration

`bridge-mcp` must expose session-first tools:

- `bridge_session_list`
- `bridge_session_create`
- `bridge_session_attach`
- `bridge_session_send`
- `bridge_session_status`
- `bridge_session_route_message`

`bridge_route_message` can remain during `0.2.x` as compatibility-only and must
be documented that way in MCP metadata.
