# bridge

`bridge` connects local coding agents to external messaging channels. The local
folder is `open-bridge`; the public package is `@hasna/bridge`; the CLI is
`bridge`.

## Install

```sh
bun install -g @hasna/bridge
```

## Commands

The `0.2.x` direction is session-first. A channel conversation attaches to a
bridge session, and normal messages go to that session. Agent adapters that do
not yet expose a stable create/send/resume API are marked `compatibility` in
session state.

Session surface:

```sh
bridge sessions list
bridge sessions create --agent codewith --cwd /repo
bridge sessions attach SESSION_ID --channel telegram-main --conversation 123456789
bridge sessions use SESSION_ID --channel telegram-main --conversation 123456789
bridge sessions detach --channel telegram-main --conversation 123456789
bridge sessions pause SESSION_ID
bridge sessions resume SESSION_ID
bridge sessions close SESSION_ID
bridge sessions send SESSION_ID "status"
```

Route compatibility surface:

```sh
bridge init
bridge doctor
bridge channels add-telegram telegram-main --token-env TELEGRAM_BOT_TOKEN --allowed-chat-ids 123456789
bridge channels add-imessage imessage-main --allowed-handles +15555550100 --default-handle +15555550100
bridge profiles add codewith-main --agent-kind codewith --auth-profile account001 --cwd /Users/hasna
bridge agents add codewith --kind codewith --profile codewith-main
bridge routes add telegram-codewith --from telegram-main --to codewith --chat-ids 123456789
bridge serve
bridge daemon start
```

The session-backed multi-channel plan for the `0.2.x` release is tracked in
[`docs/session-bridge-plan.md`](docs/session-bridge-plan.md).

Useful inspection commands:

```sh
bridge config path
bridge config show
bridge channels list
bridge profiles list
bridge agents list
bridge routes list
```

Direct operations:

```sh
bridge send telegram-main 123456789 "hello"
bridge send imessage-main +15555550100 "hello"
bridge ask codewith "summarize this repo"
bridge route-message --channel telegram-main --chat-id 123456789 --text "status" --json
bridge sessions route-message --channel telegram-main --chat-id 123456789 --text "status" --json
```

Daemon operations:

```sh
bridge daemon start
bridge daemon status
bridge daemon logs --lines 100
bridge daemon restart
bridge daemon stop
```

`bridge daemon start` uses the process supervisor by default. It starts
`bridge serve` in the background, inherits the current environment, and writes
private metadata and logs under `~/.hasna/bridge/daemon`.

For login-started services:

```sh
bridge daemon install --supervisor auto
bridge daemon start --supervisor auto
bridge daemon stop --supervisor auto
bridge daemon uninstall --supervisor auto
```

`install` writes a user `launchd` file on macOS or a user `systemd` file on
Linux. Telegram token values are not written to those files. Make token
environment variables available to the user service manager before starting an
installed daemon.

macOS:

```sh
launchctl setenv TELEGRAM_BOT_TOKEN "$TELEGRAM_BOT_TOKEN"
bridge daemon start --supervisor launchd
```

Linux:

```sh
systemctl --user import-environment TELEGRAM_BOT_TOKEN
bridge daemon start --supervisor systemd
```

## Profiles

Profiles let one bridge process route messages to multiple accounts without
changing global agent login state.

Codewith:

```sh
bridge profiles add cw-account001 --agent-kind codewith --auth-profile account001 --cwd /repo
bridge agents add codewith-main --kind codewith --profile cw-account001
```

Claude:

```sh
bridge profiles add claude-account001 --agent-kind claude --home ~/.hasna/accounts/profiles/claude/account001
bridge agents add claude-main --kind claude --profile claude-account001
```

AIcopilot:

```sh
bridge profiles add aicopilot-main --agent-kind aicopilot --cwd /repo
bridge agents add aicopilot-main --kind aicopilot --profile aicopilot-main
```

## MCP

`bridge-mcp` exposes:

- `bridge_status`
- `bridge_config`
- `bridge_route_message`

## State

Default config path:

```sh
~/.hasna/bridge/config.json
```

Override with `BRIDGE_HOME` or `BRIDGE_CONFIG`.

`bridge` stores configuration and runtime state with private file permissions.
Telegram bot tokens should stay in environment variables; config stores the env
var name, not the token value. Telegram channels fail closed unless
`allowedChatIds` are set or `allowAllChats` is explicitly enabled.
Disabled channels do not match or deliver routes. Channel-level `allowedChatIds`
are enforced before route matching, and long-poll offsets are persisted in
`~/.hasna/bridge/state.json` so restarts do not replay already-seen terminal
updates.
MCP config inspection redacts profile and agent environment values.

Session state also lives in `~/.hasna/bridge/state.json`: `sessions`,
`bindings`, `messageLedger`, and `cursors`. The daemon records inbound messages
in the ledger and advances Telegram offsets only after a terminal state:
delivered, skipped, or unauthorized. Failed messages remain retryable and do
not advance the Telegram offset. If an agent succeeds but outbound delivery
fails, the response is stored as `agent_completed` so retry delivery does not
re-run the agent.

Daemon metadata and logs are private as well. Logs can contain prompts and agent
responses, so treat them as sensitive.

## Telegram Smoke Test

Create a bot with BotFather and set the token only in your shell:

```sh
export TELEGRAM_BOT_TOKEN='123456:...'
```

Send any message to the bot from the Telegram account or group you want to use,
then find the chat id:

```sh
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates"
```

Configure one allowed chat and a test shell agent:

```sh
bridge init
bridge channels add-telegram telegram-main --token-env TELEGRAM_BOT_TOKEN --allowed-chat-ids CHAT_ID --default-chat-id CHAT_ID
bridge profiles add shell-echo --agent-kind shell --command printf --arg 'bridge ok: {prompt}'
bridge agents add echo --kind shell --profile shell-echo
bridge sessions create --id test-session --agent echo
bridge sessions attach test-session --channel telegram-main --conversation CHAT_ID
bridge doctor
bridge daemon start
bridge daemon status
```

Send a plain Telegram message to the bot. It should reply with `bridge ok: ...`
without any prefix.
Inspect logs with `bridge daemon logs`, then stop it with `bridge daemon stop`.

For Telegram forum topics, use `CHAT_ID:THREAD_ID` as the conversation value.

For the first live test, use the default process supervisor above because it
inherits `TELEGRAM_BOT_TOKEN` from your shell. Move to launchd/systemd after that
works.

## iMessage

iMessage is a local macOS channel. Sending uses the Messages app through
`osascript`, so macOS may ask for Automation permission for the terminal or
daemon host process.

Configure a send-only channel:

```sh
bridge channels add-imessage imessage-main --allowed-handles +15555550100 --default-handle +15555550100
bridge send imessage-main "hello"
```

If your Mac has more than one Messages account, add the account selector:

```sh
bridge channels add-imessage imessage-main --allowed-handles +15555550100 --account you@example.com
```

Enable local receive polling only when you are comfortable granting the daemon
host access to Messages data:

```sh
bridge channels add-imessage imessage-main --allowed-handles +15555550100 --receive
bridge sessions attach SESSION_ID --channel imessage-main --conversation +15555550100
bridge daemon restart
```

Receive mode reads `~/Library/Messages/chat.db`. If `bridge doctor` reports a
chat database permission failure, grant Full Disk Access to the terminal or
service host, or recreate the channel without `--receive`.

Inbound direct chats bind by handle. Group chats bind by local Messages chat id,
shown internally as `chat:<guid>`, and replies go back to that chat after the
sender handle passes the channel allowlist.
