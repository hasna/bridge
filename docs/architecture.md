# Bridge Architecture

`bridge` separates channel connectors from agent adapters.

Channels own external transport details such as Telegram bot tokens, chat IDs,
webhooks, or future iMessage transport. Agents own local execution details such
as Codewith auth profiles, Claude profile homes, AIcopilot state roots, command
arguments, cwd, and environment. Routes connect one channel to one agent.

The package deliberately keeps Telegram-specific behavior out of Codewith,
Claude, and AIcopilot integrations. Agent adapters receive plain text prompts
and return stdout/stderr plus process metadata. Channel connectors decide how
to receive and deliver messages.

## Data Model

- `channels`: external message transports.
- `profiles`: reusable identity/state settings for an agent family.
- `agents`: runnable targets, usually pointing at one profile.
- `routes`: mapping rules from channel messages to agents.

## Profile Model

Codewith profiles use `authProfile` and render as `codewith --auth-profile
<name> --cd <cwd> exec <prompt>`.

Claude profiles can use `home` or custom env vars so multiple accounts do not
share local state.

AIcopilot profiles currently use cwd/env/command isolation. The target repo
work dispatched on spark02 is expected to add or document first-class profile
support.

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
not replay already-seen updates and re-run agents.

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
