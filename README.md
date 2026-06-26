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
Channel-level `allowedChatIds` are enforced before route matching, and long-poll
offsets are persisted in `~/.hasna/bridge/state.json` so restarts do not replay
already-seen updates.
