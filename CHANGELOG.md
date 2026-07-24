# Changelog

All notable changes to `@hasna/bridge` are documented here.

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
- Regression coverage that malformed / non-text Telegram updates and
  conversation-less messages are dropped without crashing the dispatcher.
