# bridge

`bridge` connects local coding agents to external messaging channels. The local
folder is `open-bridge`; the public package is `@hasna/bridge`; the CLI is
`bridge`.

## Install

```sh
bun install -g @hasna/bridge
```

## Commands

```sh
bridge init
bridge doctor
bridge channels add-telegram telegram-main --token-env TELEGRAM_BOT_TOKEN --allowed-chat-ids 123456789
bridge profiles add codewith-main --agent-kind codewith --auth-profile account001 --cwd /Users/hasna
bridge agents add codewith --kind codewith --profile codewith-main
bridge routes add telegram-codewith --from telegram-main --to codewith --chat-ids 123456789
bridge serve
bridge daemon start
```

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
bridge ask codewith "summarize this repo"
bridge route-message --channel telegram-main --chat-id 123456789 --text "status" --json
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
`~/.hasna/bridge/state.json` so restarts do not replay already-seen updates.
MCP config inspection redacts profile and agent environment values.

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
bridge routes add telegram-echo --from telegram-main --to echo --chat-ids CHAT_ID
bridge doctor
bridge daemon start
bridge daemon status
```

Send a Telegram message to the bot. It should reply with `bridge ok: ...`.
Inspect logs with `bridge daemon logs`, then stop it with `bridge daemon stop`.

For the first live test, use the default process supervisor above because it
inherits `TELEGRAM_BOT_TOKEN` from your shell. Move to launchd/systemd after that
works.
