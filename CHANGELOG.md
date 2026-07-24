# Changelog

All notable changes to `@hasna/bridge` are documented here.

## 0.5.0

### Added
- **`bridge serve --resume` and resume-by-default daemon.** Serve can reconcile
  durable in-flight state (bindings, sessions, persisted getUpdates offsets, and
  interrupted ledger entries) before polling, logging a resume banner.
  `bridge daemon start`/`restart` pass `--resume` by default (opt out with
  `--no-resume`) so a restarted daemon reattaches channel bindings and resumes
  in-flight work. The getUpdates offset is persisted per channel and only
  advances on a terminal outcome, so a restart never loses or duplicates updates
  (the message ledger dedupes already-processed update ids).
- **Dead-letter for head-of-line poison.** A message whose delivery keeps failing
  no longer blocks every newer update behind it forever. After `--max-attempts`
  (default 5) it moves to a terminal `dead_letter` status, the offset advances,
  and `onDeadLetter` logs it. `bridge serve`/`daemon` accept `--max-attempts`.
- New `handleInboundMessage` / `reconcileInFlight` helpers centralize the
  offset-advance decision and are unit-tested for replay-without-duplication and
  poison-message handling.

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
  code-executing agent. It now uses an explicit **allow-list** (PATH/HOME/locale,
  XDG base dirs, and the `codewith`/`accounts`/`bun` toolchain prefixes) instead
  of a deny-list, so station secrets that do not match a credential-shaped name —
  `DATABASE_URL`, `AWS_ACCESS_KEY_ID`, `TELEGRAM_SESSION`, etc. — are dropped by
  default rather than leaking. The bridge's own channel secrets and any
  credential-shaped key are additionally stripped even if allow-listed. A tool
  that needs another var gets it via profile/agent `env` (explicit values win) or
  the new `envPassthrough` config (exact names / `PREFIX*` globs).

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
