# External input routing — verification handoff

This records the current uncommitted implementation and verification boundary,
not runtime configuration, deployment authorization or a release-readiness claim.
It supersedes the earlier ChannelInputRouter/direct-target implementation notes.

## Implemented dataflow

- `runtime/main/project-runtime.ts` composes one `InputRouter`. `route(input)` has
  no direct target argument. It matches host `InputListener` records, invokes one
  handler, deduplicates overlapping selectors for that same handler, rejects
  conflicting handlers and does nothing on a miss.
- `channels/input.ts` contains entry validation/envelope encoding, not routing or
  listener registration. `sessions/input-listeners.ts` projects live Web Session
  identities and exact enabled Personal owner-DM pairings. `bots/input.ts` projects
  deployed BOT bindings and implements the selected Service handler. The former
  `input/channel-router.ts` is removed, not renamed.
- Web uses the real injected host Request authorization before state preparation,
  fork/configuration changes or uploads. Its host identity is `web-user`; client
  sender/admin/source/listener fields cannot supply authority. New-chat preparation
  is an explicit authenticated host operation before routing, not a no-listener
  fallback. Missing/removed listeners do not execute handlers.
- Personal QQ/Feishu/Discord lazy strategies also enter the pairing listener before
  running. They retain Personal settings, not Service trigger grants. Pairing is
  separate host control-plane authentication: recording a pending proof executes
  no strategy and installs no listener; existing owner confirmation binds it.
- Service lazy policy, normalized output, observation policy and recovered/buffered
  processor attempts use the same router. Missing Service policy/observation routing
  is fail-closed. BOT trigger configuration and Discord security proofs are retained.
  Selected handlers recheck source/connection/listener permission; Service payload
  admin fields cannot elevate authority. AgentApp/SessionManager retain execution
  checks and their existing JSONL/SQLite persistence.
- Thread ancestry/native reply/media metadata is preserved. Generic producers keep
  the strict host-bound contract and remain uninstalled; no public producer API,
  tool, scheduler or cron migration is added. Internal cron/EventService stays internal.

## Passing targeted verification

Run from the repository root with pinned Node/pnpm. These are synthetic platform
and model fixtures, not live QQ/Feishu/Discord/WeChat or cross-OS deployment tests.
The project-local TMPDIR avoids macOS's symlinked temporary directory without
weakening private-path validation.

```sh
mkdir -p .test-data
TMPDIR="$PWD/.test-data" pnpm exec node --import tsx --test \
  src/input/*_test.ts src/bots/*_test.ts src/agent/dataflow_test.ts \
  src/channels/input-routing_test.ts src/channels/bot-instances_test.ts \
  src/channels/bot-modes_test.ts src/channels/feishu-capabilities_test.ts \
  src/channels/qq_test.ts src/channels/wechat-bot_test.ts \
  src/channels/web_test.ts src/channels/ingress_test.ts \
  src/channels/discord-processor_test.ts \
  src/events/input-processor_test.ts src/events/service_test.ts
```

Result: **220/220 passing**. Coverage includes real Web/ChannelManager request
admission, no unauthorized Session preparation, ignored forged authority fields,
no direct routing bypass, listener conflict/deduplication, current Personal pairing
and revocation, real Personal QQ pairing-before-policy ordering, QQ/Feishu/Discord
Service ordering/no fallback, observation/classifier gates, producer restrictions,
and real Session/provider fixtures for JSONL and SQLite.

```sh
pnpm typecheck
git -c core.whitespace=cr-at-eol diff --check
```

Both pass. `pnpm typecheck` includes backend/scripts, A2A bridge, desktop and Vue
application typechecks; this is not a packaged release or full repository test run.

## Expanded-suite limitations (not hidden by the targeted result)

Adding Discord directory/stream/history/network/capability/decision tests, the full
integration suite, channel-stream manager and durable media, realtime, session
Project/lifecycle/details, and cron automation tests produced **434 tests: 416 pass,
18 fail**:

- 14 existing `discord-decisions_test.ts` native button/permission expectations.
- `integration_test.ts`: legacy Project learning recovery expected a channel-scoped
  paused reason; the current result is undefined. Left unchanged as out of scope.
- `cron/automations_test.ts`: JSONL and SQLite context-tick fixtures time out waiting
  for the initial Session execution status at line 115. No cron production/test
  code was changed by this task; these adjacent failures were not repaired.
- `sessions/project-session_test.ts`: a pre-existing attachment fixture supplies
  invalid image bytes and fails image-header validation. This task only injected
  explicit Web test authorization elsewhere in that file, not media logic.

These are reported failures, not a clean-baseline assertion for every adjacent
subsystem. A read-only optional leaf review timed out without a verdict; no
independent-review pass is claimed.

The previously failing Web bus scope fixture now supplies a real stub realtime
callback and asserts its Project scope. No production broadcast was changed just
to evaluate an unused content getter. The old QQ fixture that relied on missing
Service policy routing was intentionally changed to assert rejection/zero delivery.
Other direct Web fixtures now explicitly supply synthetic host authorization;
client senderId no longer defeats the host identity allowlist.

## Change ownership

Implementation: input/router and producer tests; new channels/input and
sessions/input-listeners; bots/input and the narrow runtime listener accessor;
ChannelManager/BaseChannel/Web input wiring; project-runtime input composition.
Tests: renamed channel-router tests to channel-listeners, new host-listeners tests,
shared test-only channel-input composition, relevant BOT/platform/Session/Web
fixtures and the Web scope fixture. Documentation: input-routing and the external
input sections of architecture/channels/bots.

The authoring-to-BOT relocation, credential/grant services, host retirement,
learning and unrelated application edits were preserved. No commit, push, sync,
backend restart, live platform connection or arbitrary producer installation was
performed by this task.
