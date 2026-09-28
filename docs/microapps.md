# Project Micro Apps

Micro Apps are reusable Web tools owned by a Project, not temporary conversation
cards or another agent loop. Open the Project coordinator's **Apps** workspace.
Ask the agent to build a tool, then **Refresh** Apps to see its publication.
Review the exact source, local backend behavior and model allowance before
approving. Approval does not itself start the app: use **Open window** on
Electron or **Open app** in a Web browser.

The initial framework supports static HTML/CSS/JavaScript and an optional local
Node.js or Python HTTP backend. It does not provide a UI DSL, dependency
installer, app marketplace, standalone desktop packaging, remote execution,
mobile/LAN app hosting, or browser microphone/device permission broker.

## Guided construction from a short request

A reusable app request can start with the user's goal, not a complete technical
specification. The general agent discovers the Micro App skill, checks available
capabilities and asks only for material missing input or decisions. Clear requests
need no interview. Implementation, lifecycle, persistence, negative cases and
layout checks are the agent's responsibility, not a checklist the user must
discover through failed attempts.

Ordinary preferences use the existing `ask(kind: "input")` path; consequential
decisions follow the existing decision contract. An answer, a recommended default
or A2A caller input never substitutes for exact-version app owner review or
separate protected-action authorization. Safe discovery does not grant device
access. There is no new wizard, permission mechanism or minimum question count.

The agent should preserve earlier answers and requested behavior across feedback,
build an end-to-end candidate, explain what remains unverified and update the same
app through revision review. A preview or partial milestone is not a completed
app. These are prompt/skill guidelines, not runtime guarantees about model
behavior; verify them in multi-turn scenarios as well as checking final output.
Do not mistake an agent-chosen implementation prerequisite for a user requirement.
When correcting that assumption leaves the recorded goal, acceptance and
authorization unchanged, the executor can update its approach through adoption
without inventing a new goal-review gate. Actual goal/permission changes still
follow the guarded review path.

## Native windows and branding

Electron opens each Project/app pair in its own framed BrowserWindow, not an
iframe in the workbench. Repeated opens focus that window. Closing Shadow's
main window while an app is open hides the workbench in the tray; **Quit**
still shuts down all owned windows and runtimes. App windows have isolated,
non-persistent browser sessions, no preload or Node integration, no host
credentials, and no browser device-permission grants.

Minimizing or covering an open native app does not throttle its timers. Explicitly
started local work and heartbeat-based safety checks must keep running while the
user switches to another application. This is not permission to start work
automatically; closing the app still stops its runtime and cancels owned work.

Set the optional manifest field `"icon":"icon.png"` and include it in `files`
to brand the app list and native window. Use a PNG up to 512 x 512 pixels and
256 KiB (256px square recommended). The icon belongs to the immutable reviewed
revision. Older apps remain valid and use Shadow's default icon. On macOS the
shared Shadow Dock identity remains; per-app window icons are platform-dependent.

On Windows, approved apps appear in Shadow's taskbar right-click **Tasks** menu,
labeled with the app name and Project ID. Entries and cached ICO assets survive
exit. They contain only stable identifiers and trusted desktop/profile paths,
never launch tickets or credentials. A task starts Shadow when needed, or uses
the existing instance, rechecks the current approval and obtains fresh access.
Revoked or deleted apps are removed during the next catalog refresh and stale
tasks cannot bypass approval. Development profiles have separate taskbar IDs.
Windows policy or user settings can prevent task-menu publication; such failures
are reported in desktop logs. This is not a separately packaged executable per app.
Task profile arguments take precedence over environment defaults. Service-attached
desktops retain their connection descriptor rather than launching a replacement Main.

## Lifecycle and authorization

- The author publishes an explicit file list from its effective local workdir.
  Publishing saves a content-addressed snapshot, not a pointer to mutable code.
  Changed code invalidates approval. Updating requires the current revision and
  the original author session; owner lifecycle controls do not depend on that
  session remaining active.
- Project owner HTTP authorization, not an agent tool or A2A caller identity,
  permits review, approve, open, stop and revoke. Model access is opt-in and
  fixed to the owner-selected model at approval.
- Closing an Electron app window stops that app's runtime. Closing a Web
  embedded page alone does not stop its backend. **Stop** cancels model requests,
  terminates the owned backend process tree and removes the run directory.
  **Revoke access and stop** also removes approval.
- If cleanup fails, the app is marked failed with its cleanup phase, not stopped.
  **Retry cleanup** resumes the remaining cleanup without restarting Main,
  renewing model allowance or silently reopening the app. Open/approval remain
  blocked until the retained run is removed. This also applies to failed startup:
  the runtime retains ownership of a spawned backend before its health check
  succeeds, so a failed initial termination cannot leave an untracked process.
- App snapshots, approval, used-call count and data survive Shadow restarts.
  Processes do not automatically restart. An unclean prior run is shown as
  **Interrupted**, not successful or rolled back.
- Reopening creates a one-use ticket valid for 60 seconds. App access lasts at
  most eight hours per run; stop/reopen to renew runtime access. That does not
  reset the model allowance. Renewing allowance requires another owner approval.

The page runs on a separate loopback origin, with CSP sandbox restrictions
and, on Web, an iframe sandbox. It has no host preload/Node access or parent DOM
access. Electron only injects the host credential into trusted workbench
main-frame requests, never app windows or subframes. The SDK stores its
app-only runtime token in that origin's tab-scoped session storage to support
reload; tickets and tokens are never returned by the agent publication tool.
Native windows use a new nonpersistent browser partition each time. Browser
localStorage/IndexedDB therefore are not the app's durable settings store.
Static published assets are accessible on their running loopback port and must
not contain secrets.

**A backend is an ordinary host program, not an OS sandbox.** It can read files,
spawn processes and perform network operations with the host user's privileges.
Approval is code review, not confinement or dependency integrity verification.
It must authenticate its own loopback listener and must not detach descendants.
User-approved device changes and installations remain separate decisions.
Neither cancelling a request nor stopping an app rolls back external effects.

## Authoring contract

Agents read `v:skills/micro-app` and discover `micro_app` in `v:tools`.
The [built-in skill](../src/skills/builtin/micro-app/SKILL.md) documents the
manifest, SDK, backend health/authentication contract and acceptance criteria.
The read-only `micro_app` action `capabilities` and authenticated SDK `status()`
expose the same host contract: text-only inference, persistence, temporary
storage, error behavior and operational limits. Neither grants execution access.
An app directory contains `shadow-app.json` and only explicitly listed assets;
the framework accepts at most 128 files, 4 MiB each, 16 MiB total. Hidden paths,
symlinks, traversal and non-portable Windows names are rejected.

The owner API exposes lightweight app metadata at `GET /api/microapps/:id/status`
and an optional PNG at `GET /api/microapps/:id/icon?revision=<sha256>`, under the
owning Project prefix. Both require owner access; icons are not arbitrary file
reads and a stale revision is rejected.

The framework does not install app dependencies. Frontend dependencies must be
bundled. Node uses the host runtime (including Electron's Node mode); Python
must be available on PATH. Use `SHADOW_APP_DATA` for persistent files, not the
temporary script directory. Backend stdout/stderr are drained, not persisted:
report actionable, non-secret failures through HTTP responses and health checks.

Node backend startup installs a host-owned `fetch` dispatcher. It uses standard
HTTP(S) proxy environment configuration, otherwise the Windows static system
proxy, preserving Windows wildcard and `<local>` bypasses. Loopback traffic is
always direct. Configuration is captured at startup without modifying system
settings, copying proxy credentials or weakening TLS validation. Unsupported
PAC/SOCKS configuration and credential-bearing proxy URLs fail explicitly.
This is not a universal networking shim: other HTTP clients and subprocesses
retain their own proxy behavior. Python's Windows-aware clients may therefore
differ from a bare Node process run outside the Micro App host.

`SHADOW_APP_TEMP` is a private per-run directory under the extracted run. Standard
`TEMP`/`TMP`/`TMPDIR` point there too. Use it for intermediate audio and other
transient files, not models or settings. It is removed only after owned processes
stop, including failed startup and ordinary native close. Whole-host crashes are
not a guaranteed secure erase or orphan-process recovery mechanism.

The SDK exports `loadState(signal?)` and `saveState(values, version, signal?)`.
They use authenticated `GET`/`PUT /_shadow/state` and need neither a backend nor an
LLM grant (the app still needs execution approval). The JSON response is
`{version,values}`; a new/legacy app starts at version 0 with an empty object.
State is limited to 64 KiB including its envelope, scoped to Project/app, and
preserved across runs, restarts and approved code revisions. Writes require the
last read version and atomically replace the file. A stale write fails with
`app_state_conflict` (409); callers must reload and reconcile rather than retry
blindly. Invalid stored state is reported and is not overwritten or reset.
Do not persist runtime tokens, capture/playback consent or raw audio in settings.

SDK `request()` resolves to a Response only on success. HTTP failures throw
`AppRequestError` exposing `status` and `code`; malformed/non-JSON error bodies
still produce an explicit HTTP failure rather than a JSON parsing error.

Authoring can use clearly labeled, capability-free static previews before
approval. Mock layout evidence is not permission to run a backend, call a model,
or access devices, and is not a substitute for native/runtime acceptance. Large
dependencies must be reconstructible without the author workspace; an external
author seed directory is not a deployable resource.

The generic authoring skill also distinguishes result content from transient
progress: idle/status events should not fill result history or evict useful
content. It calls for bounded, separately located diagnostics and deliberate
subprocess text decoding, especially Windows PowerShell consumed as UTF-8.
These are authoring guidelines, not host-enforced UI behavior; independently
exercise idle and failure states in the generated application.
First-use and ready-state checks should keep the primary input/result/action
accessible at desktop and narrow sizes. Required setup remains actionable, but
optional technical instructions must not displace the whole primary workflow.
These layout expectations also belong to generic authoring guidance, not to a
long technical specification the user must supply.

`/_shadow/generate` accepts text messages and an optional output-token limit.
It directly calls the configured provider with no tools. It does not expose
provider credentials, private provider state or unrestricted model selection.
Requests are non-streaming, limited to 64000 input characters, two concurrent
calls, the approved output cap and the persistent attempt allowance. Failed
provider attempts count; provider-internal transport retries are not separate
app attempts. The model timeout is 120 seconds. Backend proxy transfers are
limited to 16 MiB and 180 seconds.

Project Home stores `.microapps/<app-id>/record.json`, immutable revision
bundles, optional `state.json`, and `data/`. Temporary extracted code and the
managed `.tmp/` directory live under `runs/<run-id>/`.
This registry is independent of the JSONL/SQLite conversation-store choice;
neither store is a second app registry.

## Isolated A2A acceptance

The opt-in harness sends an ordinary audio-tool request through the real A2A
endpoint to a fresh Shadow runtime. It never prebuilds the audio app. A temporary
role uses the general agent's instructions with an explicit tool allowlist,
as required by A2A. Model credentials stay in the controller process; the child
gets only a loopback model proxy credential limited to the selected model and
100 attempts. The harness requires an existing standard Copilot provider login.
It makes live model calls and can incur charges.

```powershell
$env:SHADOW_MICROAPP_LIVE = '1'
node --import tsx scripts\microapp-a2a.ts --output <new-artifact-directory>
```

Use `--prompt <UTF-8-file>` to replace the initial product request, without
appending implementation hints. Omit the operator `message` control when
measuring a one-shot run. A fresh round never reuses generated app code.
Runtime data is created under the fresh output directory and removed on finish.
The model proxy binds directly to port zero; the test Main gets a separately
selected free loopback port and must acknowledge readiness before owner requests.
No conflicting listener is terminated or reused. `isolation.json` records the
source root, owned PIDs and actual ports, without credentials.

Optional `--test-boundaries <UTF-8-file>` adds explicit test-only safety/resource
limits to the isolated role, not to the user message. They are recorded separately
in `isolation.json`. Do not hide product requirements or implementation recipes
there; keep the short request and every user answer independently auditable.
Progress/conversation artifact replacement retries transient Windows rename
contention at most four times, with bounded delays and explicit diagnostics.
It does not retry model requests; unrelated or persistent write failures still
fail the controller. A controller failure with a last-observed working task is
not a completed app revision.

For guided multi-turn tests, start with a short user goal and use `message` only
to answer the actual pending question or give user-level feedback after a turn.
Do not supply unsolicited engineering fixes or a hidden full specification.
Input-required replies retain the exact task and context; feedback after a
terminal task continues the context without reusing the terminal task ID.
Messages during working/submitted tasks are rejected by the test controller.
`conversation.json` records each attempted input verbatim, its initial/answer/
followup classification, the question being answered, model-call counts and the
returned task identity/status. An attempted input is not marked accepted before
the server acknowledges it. This ledger is separate from app approval controls.

Use fresh runtime data and an isolated source snapshot while another development
instance is in use: separate data/ports alone do not prevent source watchers or
live skill reloads from observing edits. Keep device/paid-model acceptance separate
from deterministic fixtures; a scripted provider verifies plumbing, not that a
real model will ask good questions or build a working application.

Every run uses a new Home, Project, session store, workdir, user profile, ports
and test credentials. It does not copy or delete the user's current memory,
sessions or apps. The fixed request allows at most 1 GiB new downloads and
4 GiB test resources, asks for repeatable LLM translation and local Japanese
TTS/WAV, and forbids drivers/default-device changes/VRChat playback. These
resource limits are instructions to the agent, not filesystem quotas.

Inspect `progress.json`, `task.json` and `apps.json` in the artifact directory.
Provider failures also save a bounded, allowlisted error-class/network-code
chain in `provider-failure.json`, without request content, URLs or credentials.
The operator must review generated code before creating `control.json` with a
new command `id`. Supported controls:

| Action | Required fields beyond `id`, `action` |
| --- | --- |
| `message` | `text`; continues the same A2A context, including input-required tasks |
| `approve` | `appId`, exact reviewed `revision`; invokes the real owner API |
| `open` | `appId`; writes a one-use URL to `launch.private.json`, never to logs |
| `restart` | None; restarts only this test's Shadow runtime, preserving this round's app |
| `finish` | None; stops the round and cleans only its uniquely named test directory |

An example approval control is
`{"id":"review-1","action":"approve","appId":"<uuid>","revision":"<sha256>"}`.
Read `control-result.json` before sending the next command. Finish is cleanup,
not an assertion that audio acceptance passed: inspect the actual app UI,
translation, WAV bytes, repeat runs and restart result. Artifacts preserve
sanitized task/trace/source evidence; the private launch handoff is removed.
Each subsequent round must use a new artifact directory.
`bundles/<app-id>.json` preserves the final immutable source bundle before
test cleanup; it is not an installed app or an execution authorization.

Framework fixture tests and a successful app registration do not establish
audio quality, real device routing, dependency compatibility or production
release readiness. Record any blocked prerequisite separately from framework
behavior.
