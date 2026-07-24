# Changelog

All notable changes to `@hasna/bridge` are documented here.

## 0.7.0

### Added
- **Full YOLO mode for codewith agents.** Bridge codewith runs now pass
  `--dangerously-bypass-approvals-and-sandbox` alongside `--skip-git-repo-check`
  on every codewith invocation (durable + compatibility exec paths), so the
  agent can ACT — full write+exec, no approval prompts, no read-only sandbox —
  and escape its project folder when needed. Previously a run executed
  `sandbox: read-only, approval: never` (view-only) and dead-lettered
  "Not inside a trusted directory". (The durable path invokes `codewith`
  directly with `--auth-profile`, so the YOLO flags ride the exec argv rather
  than an `accounts --permissions` preset.)
- **Per-agent project + channel provisioning.** Each bridge agent lazily
  provisions (idempotently, on first use) its OWN projects-CLI project — a
  dedicated folder (convention: `~/workspace/hasnaxyz/agent/agent-<name>`,
  override with `BRIDGE_AGENT_WORKSPACE_ROOT`) used as the agent run cwd — and
  its OWN conversations channel `agent-<name>` for activity/claims/results,
  matching the agent-ea / agent-marcus / agent-chief-of-staff convention. The
  provisioned `workspace` (projectId/path/channel) is persisted into the agent
  config; explicit session/agent/profile `cwd` still wins. Provisioning is
  opt-in via `runAgent` deps (CLI serve/ask wire it) and never blocks a run:
  a projects/conversations outage still yields a usable folder and is retried
  on the next run.

### Fixed
- **Auth-profile rotation now carries conversation context.** Durable codewith
  runs previously went through `accounts run codewith -p <profile>`, which points
  `CODEWITH_HOME` at a per-account directory and so forked the thread store per
  billing account — a thread created under account A was unreadable under account
  B, forcing a brand-new session (and a misleading "context was reset" note) on
  every rotation. The adapter now invokes `codewith` directly against one shared,
  stable `CODEWITH_HOME` and selects the paying account with codewith's native
  `--auth-profile` flag. Threads/rollouts live under `CODEWITH_HOME/sessions`
  keyed only by thread id, so a conversation keeps a single, auth-independent
  `thread_id` that is resumed under whichever account pays. On exhaustion,
  rotation switches **only** the billing account and resumes the **same** thread
  (`codewith exec resume <thread_id> --auth-profile <next>`); it starts a fresh
  thread only as a genuine stale-thread fallback.
- **`CONTEXT_RESET_NOTE` is no longer shown for normal rotation.** It is prepended
  only when the thread was genuinely unrecoverable (a self-healed stale session),
  so users are told about a context reset only when one actually happened.

### Hardened
- **Failed runs surface a clear ERROR REPLY.** A message that dead-letters now
  sends the sender an explicit `⚠️ I could not process that message …` reply
  (via the normal allow-listed response path) carrying the structured codewith
  error — nested JSON-encoded provider errors are unwrapped — instead of dying
  silently in the ledger.
- **Non-fatal tool diagnostics never break or pollute a run.** shell_snapshot
  validation warnings (and similar timestamped tool log lines) on stderr do not
  fail a successful run and are stripped from user-facing failure text
  (`filterAgentLogNoise`); only a timeout or non-zero exit fails a run. The
  filter is deliberately narrow: only TRACE/DEBUG lines, timestamped
  tracing-crate lines with a `module::path:` target, and codewith's stdin echo
  are stripped — genuine fatal stderr (e.g. `ERROR: invalid API key`) is KEPT
  in user-facing failure text.
- **Channel provisioning is tracked separately and retried.** A failed
  `agent-<name>` channel create no longer lets the pass be marked provisioned
  (previously `provisionedAt` was gated only on the project half, so a
  transient conversations outage skipped the channel forever). The channel half
  is confirmed on its own `channelProvisionedAt` and a full pass requires both
  halves; conversely a projects outage no longer re-creates an already
  confirmed channel. Already-exists detection is narrow (genuine
  `already exists`/`duplicate`/`conflict`/HTTP 409 shapes only) so unrelated
  failures like "no such tenant exists" are not silently swallowed.
- **The agent project gets a REAL primary path.** `projects create` is invoked
  with `--yes` (approving path/dir effects) and, whenever the registry record
  still reports `primary_path=null` (api-mode create registers without path/dir
  effects), the path is pinned deterministically with
  `projects update <id> --path <folder> --json`. A prompt-agent create that
  stops at a plan falls back to the deterministic create (after re-reading by
  name so nothing is duplicated). Project-record parsing understands the
  prompt-agent run wrapper (`projects: [...]`, `tool_calls[].output.project`).
- **Every agent kind runs from its provisioned folder.** The per-agent
  workspace cwd now applies to claude/aicopilot/shell/custom-command
  compatibility agents too, not only codewith.

### Changed (breaking, pre-1.0)
- `AgentSessionRef` drops the per-profile `providerSessions` map; the conversation
  thread is the single shared `refId`. `recordDurableSession` / `resolveDurableTarget`
  now read/write `refId` directly. Persisted `0.6.x` state still loads and resumes
  via the stored `refId`.
- Removed the `buildAccountsCommand` export (the store-forking accounts wrapper).
  New helpers: `buildCodewithCommand` (invokes `codewith` directly) and
  `resolveCodewithHome` (resolves the shared home). `buildCodewithExecArgs` gains
  an `authProfile` option that emits `--auth-profile`.

## 0.6.1

### Hardened
- **Exhaustion detection is now structured, not a raw-string match.**
  `isExhaustionSignal` classifies codewith `--json` *error events* (their
  type/code/message fields) plus exit code, so the assistant merely mentioning
  "rate limit" or "429" in a normal reply no longer triggers a rotation.
- **Cross-profile rotation resets context honestly.** When exhaustion rotates to
  a backup profile (whose durable session is not resumable from the exhausted
  one) — or a stale session is self-healed — the reply is prefixed with a
  user-visible note (`CONTEXT_RESET_NOTE`) instead of pretending the switch was
  seamless. An optional `checkUsageExhausted` probe (e.g. `codewith usage`) lets
  rotation skip a known-exhausted profile before spawning it.
- **Stale-session self-heal.** If resuming a stored `thread_id` fails because the
  session/rollout is gone (`isStaleSessionSignal`), the turn retries once on a
  fresh session instead of erroring forever, and marks the reply as context-reset.
- **Canonical session-id capture.** `extractCodewithSessionId` prefers the
  `{"type":"thread.started","thread_id":"<uuid>"}` session-start event (and its
  aliases) over any later event that merely echoes an id.

## 0.6.0

### Added
- **Automatic auth-profile rotation on exhaustion.** codewith agents accept an
  ordered `fallbackProfileIds` rotation pool (`bridge agents add ... --profile A
  --fallback-profile B C`). When the active profile hits a usage/quota/auth
  exhaustion signal (rate-limit / quota / auth-expired / 429 / 401 / 403), the
  durable adapter rotates to the next profile and continues the turn in the same
  call. Each profile keeps its own codewith session id, so switching profiles
  accepts a fresh context on that profile the first time it is used (a codewith
  session created under one profile is not resumable under another); once
  rotated, the bridge session is pinned to the healthy profile and later messages
  resume its session directly. `bridge doctor` reports an `auth-rotation:<agent>`
  check for pool validity.
- `isExhaustionSignal`, `rotationProfiles`, `activeRotationProfile`, and
  `nextRotationProfile` helpers, unit-tested including an end-to-end simulated
  exhaustion that rotates and continues the session.

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
- Regression coverage that a per-conversation codewith `thread_id` survives a
  state `saveState`/`loadState` restart and is resumed with `codewith exec resume
  <thread_id>` on the next message.

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
  owner chat) falls back to the sole configured `codewith` agent, so the reply
  routes to an agent instead of the "no session" help text. Ambiguous configs
  (several codewith agents) still refuse to guess; non-codewith agents are never
  auto-selected.
- Regression coverage that malformed / non-text Telegram updates and
  conversation-less messages are dropped without crashing the dispatcher.
