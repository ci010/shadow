# Project Micro Apps

Micro Apps are reusable Web tools owned by a Project, not temporary conversation
cards or another agent loop. Open the Project coordinator's **Apps** workspace.
Ask the agent to build a tool, then **Refresh** Apps to see its publication.
Review the exact source, local backend behavior and model allowance before
approving. Approval does not immediately start the app. The runtime asks whether
its author should continue testing; an unanswered 60-second confirmation defaults
to continuing. Choose **Not now** to test it yourself with **Open window** on
Electron or **Open app** in a Web browser.

The initial framework supports static HTML/CSS/JavaScript and an optional local
Node.js or Python HTTP backend. It does not provide a UI DSL, dependency
installer, app marketplace, standalone desktop packaging, remote execution,
mobile/LAN app hosting, or browser microphone/device permission broker.

## Guided construction from a short request

Agree on shared interfaces and cancellation ownership before parallel coding,
then exercise a thin end-to-end path early. Keep fixture checks, actual app
checks, tool blockers and pending owner review distinct. After a transport
interruption, inspect existing work and worker state rather than recreating
completed effects or launching a second writer. Late reports already incorporated
into a result need no additional user-facing acknowledgement.

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
access. There is no setup wizard or minimum interview question count; the
post-review testing confirmation is separate from execution approval.

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

## Author runtime acceptance

After approval, the existing owner question card offers **Continue runtime
testing** or **Not now; I will test it myself**. The question is local to the
Project owner, even for an A2A or child author; it is not sent to a remote caller,
parent agent or channel. Its answer is recorded through the existing JSONL/SQLite
decision journal. The 60-second default applies only to continuing tests of the
already approved revision, never to code approval, new device access or Work
changes. Cancellation and custom replies pause testing. Cancelling this host
confirmation does not cancel unrelated conversation work.

Continuing queues a runtime event to the original author through SessionManager.
`micro_app test` opens the approved app in a fresh, session-owned managed browser,
returning an instance handle rather than a launch ticket. Normal browser tools,
role checks and Work admission remain in force. An owner-opened runtime is not
taken over or stopped by the author: the owner stops it first. Tests consume agent calls and any app calls they make
count against the existing allowance. Device permissions and the backend's normal
host access are unchanged; this is not a sandbox.

Notification admission is separate from author execution. Apps distinguishes
queued, author working, runtime testing, and a saved report. Matching native
turn-start/finish events record author activity; an ended turn without a report
becomes incomplete, blocked by a recorded Work reason, failed or interrupted.
Only a completed turn may be classified using a Work blocker. A failed turn
retains its execution error (bounded to 1000 characters); cancellation remains
interrupted. An old "waiting for approval" progress note cannot replace a newer
provider/budget failure, and a saved report is not overwritten by a later error.
Unrelated turns and stale requests cannot finish the current test. No state
automatically resends the event or renews allowance.

The author saves `micro_app report` for startup/preparation, SDK state across
runs, failure/cancel recovery, and stop/reopen. Host observations contain bounded
run IDs, event kinds, counts and state versions, not request bodies or credentials.
They establish that a runtime boundary was exercised, not that a business result
is correct. Passing assessments need genuine recorded tool excerpts; runtime
claims also need matching host observations. Fixture and untested results remain
explicitly separate, and device/translation quality must not be inferred from
fixture providers. Apps shows the report as the **author's assessment**, not a
blanket host-certified pass.

`micro_app evidence` accepts the approved app ID, exact revision and 1-12
`sources:[{id,quote}]` entries identifying recorded tool calls and exact result
excerpts. It returns canonical `{sessionId,physicalId,kind:"tool",id,quote}`
references for copying into reports. Lookup is read-only, limited to the
original author's own current/historical segments, and rechecks testing
authorization after reading. It does not search peer/parent logs or guess the
current segment. Missing calls, ambiguous cross-segment IDs and inexact excerpts
fail explicitly; they never become a fabricated reference or passing assessment.
Complete references remain supported and are independently verified at report
submission. Lookup does not write a report or consume app model allowance.

Publication captures the active, adopted Work acceptance criteria with their
Work keys and revisions. This is a version-bound audit snapshot, not a second
task store; later Work edits do not rewrite the published baseline. The report's
`requirements` must account for every captured criterion exactly once using
`workKey`, `workRevision`, and a zero-based `criterion`, plus the same assessment,
observations and evidence fields as lifecycle checks. `blocked` and `not_tested`
are valid: unavailable hardware must not be fabricated as a pass. Legacy
publications without captured Work criteria explicitly show incomplete coverage
information rather than implying that lifecycle checks prove feature delivery.
Report validation is a no-effect rejection, allowing corrected evidence without
settling a fictitious execution; persistence failures remain uncertain.
Observation validation reports all unknown IDs and missing lifecycle citations
in one rejection, with check/requirement paths, the required relationship and a
small candidate ID set from the same testing request. It never inserts evidence,
changes results or saves a partial report. Candidates establish only a host
boundary; the author must verify relevance and retain genuine tool excerpts.
An empty candidate set means retained observations cannot establish that check,
not that a truncated history proves it never happened. Repair affected citations
without downgrading unrelated supported checks; other evidence is validated
after citation errors are corrected.
Schema errors name the exact field, for example
`report.requirements[1].observations`. `basis=runtime` requires nonempty host
observations even when `result=blocked` or `failed`; result describes the outcome,
whereas basis describes what was exercised. Invalid tool-source references name
their evidence item and provide an `evidence` lookup request, rather than requiring
the author to discover physical session metadata through decision tools.

For runtime state, cite `state_saved` and a later `state_read` of the same version
on another run. Reopen requires `stopped` then a later `sdk_connected` on another
run, not a full Shadow restart. Recovery requires a model/backend failure or
cancellation followed by a completion of that same kind. Starting a run or
reading its state does not substitute for its SDK connection. These requirements
do not certify dependency readiness, device isolation or business correctness.

Testing requests and reports bind both revision and approval. Updating code or
revoking authorization prevents further author test entry. Previous records stay
in `.microapps/<app-id>/acceptance-<request-id>.json`; new publications do not
inherit them. Old approvals do not silently acquire testing permission.
Restarted confirmations and uncertain notifications do not automatically replay:
inspect prior effects, stop the app, and use **Ask to run tests again**. This asks
again without resetting the model allowance. Missing/deleted/one-shot authors,
existing pending decisions and notification failures remain explicit blockers.

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
  On Windows, a failing `taskkill` can race with a backend's natural exit.
  Cleanup waits up to five seconds for the owned close/output-drain receipt.
  A verified close is retained with a warning; unresolved exit or pipes remain
  failures with the original termination error, not a fabricated stopped state.
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

Directory/manifest validation failures in `micro_app publish` are reported before
the publishing service runs, so Work does not require reconciling a publication
that never started. Cancellation and failures after the service is entered remain
conservative: inspect possible effects before retrying. This does not approve an
app or relax manifest validation.

The read-only authoring action `micro_app({action:"check",directory,id,revision})`
compares the current manifest and its listed files with the exact published
bundle, returning a candidate hash and added/modified/removed file names. It
uses the same file validation as publication and refuses stale or concurrently
changed revisions. It does not publish, grant approval, start a process, resolve
unlisted dependencies or verify behavior. A changed draft is not a shipped fix;
publish and review the new revision before testing the actual app.

`publish` and `check` tool replies are compact receipts: exact ID/revision,
approval and model allowance, run/error status, versioned `workRefs`, an
`acceptanceSummary`, and the full source comparison for `check`. `reportSaved`
only says a report exists, not that its checks passed. Use the returned `detail`
(`get`) for the full manifest, acceptance criteria, observations and report
before assessing or reporting acceptance. The owner HTTP views, persisted
records and `get`/`test`/`report` evidence are unchanged.

The owner API exposes lightweight app metadata at `GET /api/microapps/:id/status`
and an optional PNG at `GET /api/microapps/:id/icon?revision=<sha256>`, under the
owning Project prefix. Both require owner access; icons are not arbitrary file
reads and a stale revision is rejected.

The framework does not install app dependencies. Frontend dependencies must be
bundled. Node uses the host runtime (including Electron's Node mode); Python
must be available on PATH. Use `SHADOW_APP_DATA` for persistent files, not the
temporary script directory. Backend stdout/stderr are drained, not persisted.
During startup the host recognizes missing-dependency and syntax-error signatures
using bounded transient text, then reports only a fixed diagnostic category in
the startup error. It does not expose raw output, module names, tokens or payloads.
This helps distinguish author-directory success from packaged-runtime failure;
it is not automatic dependency installation or a substitute for app health checks.

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
at most 100 attempts. `--max-calls <1-100>` can lower that cap for a focused
recovery or interaction probe; the effective cap is recorded in the run artifacts.
A passing narrow probe is not evidence of complete app acceptance.
The harness requires an existing standard Copilot provider login.
It makes live model calls and can incur charges.

```powershell
$env:SHADOW_MICROAPP_LIVE = '1'
node --import tsx scripts\microapp-a2a.ts --output <new-artifact-directory>
```

Use `--prompt <UTF-8-file>` to replace the initial product request, without
appending implementation hints. Omit the operator `message` control when
measuring a one-shot run. A fresh round never reuses generated app code.
Runtime data defaults to `<output>/runtime`. Before removing it, the controller
awaits shutdown and exports published bundles plus bounded source recovery
snapshots. On Windows,
use `--runtime-root <fresh-short-project-local-directory>` (for example,
`.test-data\a2a-run-1`) when the artifact directory is deep: Python native
extensions and older compilers may fail under long session paths. The explicit
runtime root must not exist or contain/be contained by the artifact output;
the harness does not reuse or clean an existing directory. Profiles and caches
follow this root, which is recorded in `isolation.json`; artifacts stay in output.
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

`recovery.json` indexes exact-byte/base64 source archives under `recovery/`,
including UTF-8 BOMs, unfinished manifests, unlisted source files and differences
from published versions. `work-details.json` retains last-observed full Work
records, separately from version-bound published acceptance. These are drafts
and evidence, not new publications, approval or successful acceptance.
Recovery uses registered local session workdirs within the isolated Project;
it does not follow links or inspect remote display paths. Hidden metadata,
credential-named files and generated dependency/test-data directories are excluded.
Python environments are also recognized by a regular `pyvenv.cfg`, regardless of
their directory name, and excluded before traversing installed packages. Linked
markers are not followed and do not hide otherwise recoverable source.
The source scan is capped at 8192 entries, 256 files, 4 MiB per file and 16 MiB
total. Known runtime credentials reject export. Source hashes are checked before
runtime deletion. Failed shutdown/export preserves the runtime directory and
reports `recovery-failure.json`; it must not delete the only remaining source.
This is source recovery, not a backup of environments, app data or permissions.

Python app backends start with `-X utf8` and explicit UTF-8 stdio environment.
Generated isolated Python workers should also use `-I -X utf8`, since `-I`
ignores `PYTHON*` environment variables. PowerShell source-file encoding remains
separate from console input/output encoding; the Micro App skill documents both.

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
Source snapshots must not run package installation through junctions pointing at
the normal development `node_modules`; use independent writable dependency copies.

Each session inference receives the remaining requests in its existing 100-step
turn limit, including the current request. The live controller additionally shows
the remaining evaluation-wide budget to tool-using author requests; follow-ups
and author testing share that budget. It does not inject authoring guidance into
the app's tool-free translation requests. At 20 or fewer remaining requests,
guidance prioritizes a reviewable publication and honest acceptance record over
optional polish. The live controller reserves separate bounded phases:

| Phase | Wall-time limit | Transition |
| --- | --- | --- |
| Creation | 30 minutes, including feedback and clarification | Explicit `review`/`approve` after the creation task ends, or the creation cutoff |
| Owner source review | 5 minutes, with no model requests admitted | Exact-version owner `approve`; timeout never approves |
| Author testing | 10 minutes from the first successful version approval | Includes the existing 60-second testing question, preparation and reporting |

The absolute maximum is 45 minutes; early handoff does not wait out unused
creation time. At the creation cutoff, in-flight model requests are aborted and
an active A2A task is cancelled with its actual terminal outcome recorded before
review. Already published bytes remain available for inspection; interrupted
implementation is not declared complete or silently published. No candidate means
the run ends with source recovery rather than fabricated delivery.
Phase closures return non-retryable model-admission rejections. The final five
minutes of creation and testing carry closing guidance, even when requests remain.
Requests in progress receive the phase deadline signal.

`timeline.json` and `progress.json.timeline` expose the phase, its deadline and
the absolute ceiling. `progress.json.deadlineAt` is the **current phase** deadline,
not always the final shutdown time. Repeat reviews do not extend review; later
revision approvals, runtime restarts and testing retries do not reset the first
testing deadline. New product follow-ups are accepted only during creation.
During testing, new revisions still require independent exact-version review,
within the remaining testing window, not another five-plus-ten-minute allowance.
The request ceiling is unchanged and shared; reserving time does not reserve
additional model calls, grant permission, guarantee a report, or turn a timeout
into a passed test. `finish` may end any phase early without claiming acceptance.
Transient budget text is not added to persisted conversation history.

Every run uses a new Home, Project, session store, workdir, user profile, ports
and test credentials. It does not copy or delete the user's current memory,
sessions or apps. Package/model caches (npm, pip, uv, Hugging Face, Torch and
NuGet) and Python's user install prefix are also redirected inside that run;
dev environment variables are not inherited. Controller failures leave a failed
final state and a diagnostic, not a stale claim that the run is still running.
The fixed request allows at most 1 GiB new downloads and
4 GiB test resources, asks for repeatable LLM translation and local Japanese
TTS/WAV, and forbids drivers/default-device changes/VRChat playback. These
resource limits are instructions to the agent, not filesystem quotas.

Inspect `progress.json`, `task.json`, `apps.json` and `work.json` in the artifact
directory. Progress includes blocked Work and pending proposal counts: a completed
A2A turn does not imply that the requested refinement has been implemented or
accepted. `creation-stop.json` records a timed creation cutoff, including any
actual cancellation outcome. The author may still be in its separate testing
turn after the original A2A task completed; inspect `apps.json` acceptance status
and its version-bound report, not just `task.json`.
Provider failures also save a bounded, allowlisted error-class/network-code
chain in `provider-failure.json`, without request content, URLs or credentials.
The operator must review generated code before creating `control.json` with a
new command `id`. Supported controls:

| Action | Required fields beyond `id`, `action` |
| --- | --- |
| `message` | `text`; during creation, continues the same A2A context, including input-required tasks |
| `snapshot` | None; exports current immutable published bundles without changing phase or granting access |
| `review` | `appId`, exact `revision`; after the creation task ends, begins review early and saves source in `review.json` and `bundles/` |
| `review-work` | `workKey`; saves the exact current contract/proposals in `work-review.json` |
| `approve-work` | `workKey`, `workRevision`, `proposalId`; applies only that current pending proposal via the dedicated owner API |
| `approve` | `appId`, exact reviewed `revision`; invokes the real owner API and starts the first testing window; can enter review implicitly from completed creation |
| `open` | `appId`; writes a one-use URL to `launch.private.json`, never to logs |
| `restart` | None; restarts only this test's Shadow runtime, preserving this round's app |
| `finish` | None; stops the round and cleans only its uniquely named test directory |

After the final product input is handled and the creation task ends, use
`{"id":"inspect-1","action":"review","appId":"<uuid>","revision":"<sha256>"}`
to reserve review time before inspecting the exact source. This closes creation;
do not send it after an intermediate delivery when more product feedback remains.
An example approval control is
`{"id":"review-1","action":"approve","appId":"<uuid>","revision":"<sha256>"}`.
Read `control-result.json` before sending the next command. Finish is cleanup,
not an assertion that audio acceptance passed: inspect the actual app UI,
translation, WAV bytes, repeat runs and restart result. Artifacts preserve
sanitized task/trace/source evidence; the private launch handoff is removed.
Each subsequent round must use a new artifact directory.
Work approval is separate from app-version approval. Inspect `work-review.json`
before selecting a proposal; stale revisions or assignment generations are
rejected. `work-approval.json` preserves the exact owner request and result.
Invalid/stale Work review or approval fields and explicit owner API rejections write
`control-result.json` with `done:false` and an error, without destroying the
isolated runtime and its draft. Inspect it and submit a new command ID; the
rejected command is never retried automatically. Network failures, malformed
server responses and uncertain outcomes still fail the round rather than
pretending approval succeeded or replaying a request.
Neither an A2A message nor an operator Work approval grants app execution/model
access, changes adoption or progress automatically, or approves future proposals.
`bundles/<app-id>.json` preserves the final immutable source bundle before
test cleanup; it is not an installed app or an execution authorization.

Framework fixture tests and a successful app registration do not establish
audio quality, real device routing, dependency compatibility or production
release readiness. Record any blocked prerequisite separately from framework
behavior.
