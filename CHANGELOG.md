# Changelog

All notable changes to `@hasna/bridge` are documented here.

## 0.4.0

### Added
- **Durable codewith sessions driven through `accounts`.** codewith agents now
  run via `accounts run codewith -p <profile> -- exec --json --durable -o <file>`
  so each conversation keeps a real codewith session id and resumes it with
  `codewith exec resume <SESSION_ID>` on the next message and across restarts.
  Session ids are stored per auth profile on the bridge session
  (`agentSession.providerSessions`), because a codewith session is only resumable
  under the profile that created it. The bridge never uses `accounts run --resume`
  / codewith `--last` (which target the most-recent session for the profile and
  would cross-contaminate multiplexed conversations).
- Reply text is isolated from the JSONL event stream via the codewith
  `--output-last-message` file (falling back to the parsed final assistant
  event). Structured stdout is flagged and is never relayed to the user.

### Security
- `buildAgentEnv` no longer inherits the full station environment into the
  code-executing agent. The bridge's own channel secrets (Telegram bot tokens,
  webhook secrets) and credential-shaped env keys are stripped before spawning;
  operators can re-add a specific key a tool needs via profile/agent `env`.

## 0.3.0

### Added
- **Inbound reply auto-sessions.** Channels can declare a `defaultAgentId`
  (`bridge channels add-telegram <id> --default-agent <agent>`). When an inbound
  message arrives for a conversation that has no session binding and no matching
  route, the bridge now lazily creates a durable session + binding for the
  channel's default agent and routes the message to it. Later messages from the
  same conversation resume that session. This is what makes replying to an agent
  from Telegram work end to end without a manual `bridge sessions create/attach`.
- `bridge doctor` now reports a `default-agent:<channel>` check that fails when a
  channel's `defaultAgentId` does not resolve to a configured agent.

### Hardened
- Auto-session provisioning is gated on channel authorization, so unauthorized
  chats can never provision sessions.
- Auto-session provisioning no longer requires an explicit `defaultAgentId`: when
  a channel omits it, an inbound reply from an already-allowlisted chat (e.g. the
  owner chat) falls back to the sole configured `codewith` agent (or the sole
  agent of any kind), so the reply routes to an agent instead of the "no session"
  help text. Ambiguous configs still refuse to guess.
- Regression coverage that malformed / non-text Telegram updates and
  conversation-less messages are dropped without crashing the dispatcher.
