# Project Micro Apps

Micro Apps are reusable Web tools owned by a Project, not temporary conversation
cards or another agent loop. Open the Project workbench's **Apps** workspace.
Ask the agent to build a tool, then **Refresh** Apps to see its publication.
Published apps, including changed revisions, can be opened immediately with
**Open window** on Electron or **Open app** in a Web browser. There is no separate
owner approval step. Publication alone does not run code. Source, backend behavior
and model limits remain inspectable in **Review details**. **Ask author to test
this version** separately asks whether the author may continue runtime testing;
an unanswered 60-second confirmation never grants that continuation.

The initial framework supports static HTML/CSS/JavaScript and an optional local
Node.js or Python HTTP backend. It does not provide a UI DSL, dependency
installer, app marketplace, standalone desktop packaging, remote execution,
mobile/LAN app hosting, or browser microphone/device permission broker.

## Native windows on a paired Child

A ready Electron Child uses its own authenticated loopback control endpoint,
then the existing paired-device MainDeviceUi challenge/proof channel for app
catalog, revision-bound open and stop. It does not start a second local
Main. The app backend and persistent state remain on the connected Main; this
is not remote-workdir app publication or public LAN app hosting.

Main's isolated loopback app URL is not usable on another machine. Child replaces
it with a separate ephemeral loopback origin for that app run. Requests relay
only to the selected Project/app, exact published revision and current run ID;
the caller cannot supply a target host or port. Each request obtains fresh device
proof. Only app-specific one-use tickets and app tokens reach the app renderer;
Main/Child control credentials never do. Requests from another Origin are rejected.
The ordinary independent BrowserWindow, nonpersistent partition and focus reuse
remain unchanged. Closing the window stops the runtime on the connected Main and
closes the Child relay; Child shutdown also closes its relay listeners. Revocation,
revision changes, device-proof failure and expired/stopped runs fail closed.

The integration fixture runs real loopback Main device ingress and Child control.
On a desktop with a display it also launches the installed Electron using a
throwaway profile: the message bridge opens a real independent BrowserWindow,
loads the app/SDK through Child, saves and reloads state, focuses on repeat open,
stops Main on close, reopens on a new origin, and rejects access after revocation.
It is not a Windows native UI/taskbar or separate-machine acceptance claim.

Child adds its own shared limits: at most 16 app relay listeners (including
reserved opening slots), 16 in-flight app relay requests across all its apps,
16 MiB decoded request/response bodies, and 24 MiB transport JSON envelopes.
A saturated request queue returns 429; oversized app input returns 413 before
forwarding. HTTP header/request receipt timeouts are 15/30 seconds. Listeners
close on stop/shutdown or run expiry (at most eight hours). These are additional
Child limits, not inherited Main listener quotas. The existing MainDeviceUi
128 active requests and 600 challenges/minute limits, exact-revision checks,
32 outstanding tickets/run and two concurrent model calls/app remain in force.
Main relay also bounds decoded request/response bodies to 16 MiB; this does not
introduce a new global cap on owner-started Main app runtimes.

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
or A2A caller input never substitutes for separate protected-action authorization. Safe discovery does not grant device
access. There is no setup wizard or minimum interview question count; the
author-testing confirmation is separate from direct owner opening.

The agent should preserve earlier answers and requested behavior across feedback,
build an end-to-end candidate, explain what remains unverified and update the same
app through revision review. A preview or partial milestone is not a completed
app. These are prompt/skill guidelines, not runtime guarantees about model
behavior; verify them in multi-turn scenarios as well as checking final output.
Do not mistake an agent-chosen implementation prerequisite for a user requirement.
When correcting that assumption leaves the recorded goal, acceptance and
authorization unchanged, the executor can update its optional local note/plan
without inventing a new goal-review gate. Coordinators maintain goal changes;
protected actions still require their dedicated approval path.

## Author runtime acceptance

When the owner requests author testing, the existing question card offers **Continue runtime
testing** or **Not now; I will test it myself**. The question is local to the
Project owner, even for an A2A or child author; it is not sent to a remote caller,
parent agent or channel. Its answer is recorded through the existing JSONL/SQLite
decision journal. The 60-second deadline defers unanswered confirmations without
approval; only explicit **Continue runtime testing** permits author testing of the
published revision. It never approves code, new device access or Work
changes. Cancellation and custom replies also pause testing. Cancelling this host
confirmation does not cancel unrelated conversation work.

Continuing queues a runtime event to the original author through SessionManager.
`micro_app test` requires an explicit owner-held browser_setup binding and opens
the published app in a new page there, returning the binding and pageId rather than
a launch ticket. It never launches a browser; multiple bindings require reducing
to one unambiguous choice before this handoff. Normal browser tools,
role and exact-version owner checks remain in force. Work notes are not an
execution prerequisite. An owner-opened runtime is not
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

`micro_app evidence` accepts the published app ID, exact revision and 1-12
`sources:[{id,quote}]` entries identifying recorded tool calls and exact result
excerpts. It returns canonical `{sessionId,physicalId,kind:"tool",id,quote}`
references for copying into reports. Lookup is read-only, limited to the
original author's own current/historical segments, and rechecks testing
authorization after reading. It does not search peer/parent logs or guess the
current segment. Missing calls, ambiguous cross-segment IDs and inexact excerpts
fail explicitly; they never become a fabricated reference or passing assessment.
Complete references remain supported and are independently verified at report
submission. Lookup does not write a report or consume app model allowance.

Publication captures acceptance criteria from the focused or unambiguous linked
goal path, including ancestors, with Work keys and semantic/assignment revisions.
It validates that explicit basis independently of ordinary tool execution,
without adoption or mandatory tracking. This is a version-bound audit snapshot, not a second
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

For runtime startup, cite both `started` and `sdk_connected`.
For runtime state, cite `state_saved` and a later `state_read` of the same version
on another run. Reopen requires `stopped` then a later `sdk_connected` on another
run, not a full Shadow restart. Recovery requires a model/backend failure or
cancellation followed by a completion of that same kind. Starting a run or
reading its state does not substitute for its SDK connection. These requirements
do not certify dependency readiness, device isolation or business correctness.

Testing requests and reports bind revision and testing-request identity. Updating
code or cancelling author testing prevents further author test entry. Previous records stay
in `.microapps/<app-id>/acceptance-<request-id>.json`; new publications do not
inherit them. Existing apps do not silently acquire author-testing permission.
Restarted confirmations and uncertain notifications do not automatically replay:
inspect prior effects, stop the app, and use **Ask to run tests again**. This asks
again without resetting the model allowance. Missing/deleted/one-shot authors,
existing pending decisions and notification failures remain explicit blockers.

## Native windows and branding

Published message links with `?microApp=<id>` route from the author conversation
to Project Apps. On Electron, the linked publication opens its native window
(or focuses the existing one) without a separate approval; Web keeps
the embedded presentation and its **Open app** action.

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

On Windows, published apps appear in Shadow's taskbar right-click **Tasks** menu,
labeled with the app name and Project ID. Entries and cached ICO assets survive
exit. They contain only stable identifiers and trusted desktop/profile paths,
never launch tickets or credentials. A task starts Shadow when needed, or uses
the existing instance, rechecks the current revision and obtains fresh access.
Deleted apps are removed during the next catalog refresh and stale
tasks cannot bypass Project authentication or revision checks. Development profiles have separate taskbar IDs.
Windows policy or user settings can prevent task-menu publication; such failures
are reported in desktop logs. This is not a separately packaged executable per app.
Task profile arguments take precedence over environment defaults. Service-attached
desktops retain their connection descriptor rather than launching a replacement Main.

## Lifecycle and authorization

- The author publishes an explicit file list from its effective local workdir.
  Publishing saves a content-addressed snapshot, not a pointer to mutable code.
  Changed code creates a ready-to-open revision and invalidates prior author testing. Updating requires the current revision and
  the original author session; owner lifecycle controls do not depend on that
  session remaining active.
- Project owner HTTP authorization, not an agent tool or A2A caller identity,
  permits inspect, open, stop and author-testing controls. Model access is declared
  by the manifest and pinned to the Project model on first open of each publication.
  The manifest bounds calls and output tokens; failed attempts consume allowance.
- Closing an Electron app window stops that app's runtime. Closing a Web
  embedded page alone does not stop its backend. **Stop** cancels model requests,
  terminates the owned backend process tree and removes the run directory.
- If cleanup fails, the app is marked failed with its cleanup phase, not stopped.
  **Retry cleanup** resumes the remaining cleanup without restarting Main,
  renewing model allowance or silently reopening the app. Open and publication remain
  blocked until the retained run is removed. This also applies to failed startup:
  the runtime retains ownership of a spawned backend before its health check
  succeeds, so a failed initial termination cannot leave an untracked process.
  On Windows, a failing `taskkill` can race with a backend's natural exit.
  Cleanup waits up to five seconds for the owned close/output-drain receipt.
  A verified close is retained with a warning; unresolved exit or pipes remain
  failures with the original termination error, not a fabricated stopped state.
- App snapshots, pinned model, used-call count and data survive Shadow restarts.
  Processes do not automatically restart. An unclean prior run is shown as
  **Interrupted**, not successful or rolled back.
- Reopening creates a one-use ticket valid for 60 seconds. App access lasts at
  most eight hours per run; stop/reopen to renew runtime access. That does not
  reset the model allowance. A changed publication starts a new allowance; an
  unchanged publish preserves usage. There is no approval/renewal endpoint.

Existing records migrate when the Project runtime loads: the old `approval` field
is removed, a matching legacy model selection is retained as the model pin, and
calls, snapshots and persistent data are preserved. Previously unapproved or
revoked publications become ready to open under the new product policy. Missing
model pins resolve from the Project default on first open. No app process or
owner testing continuation auto-resumes. Old testing timestamps no longer grant
execution permission; testing still binds the revision and request ID. This is a
forward schema migration; older binaries cannot read the rewritten records.

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
Publication is not confinement or dependency integrity verification. Opening
local backend code runs it with normal host access; inspect external effects.
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
changed revisions. It does not publish, start a process, resolve
unlisted dependencies or verify behavior. A changed draft is not a shipped fix;
publish and review the new revision before testing the actual app.

`publish` and `check` tool replies are compact receipts: exact ID/revision,
model pin and allowance, run/error status, versioned `workRefs`, an
`acceptanceSummary`, and the full source comparison for `check`. `reportSaved`
only says a report exists, not that its checks passed. Use the returned `detail`
(`get`) for the full manifest, acceptance criteria, observations and report
before assessing or reporting acceptance. The owner HTTP views, persisted
records and `get`/`test`/`report` evidence are unchanged.

The owner API exposes lightweight app metadata at `GET /api/microapps/:id/status`
and an optional PNG at `GET /api/microapps/:id/icon?revision=<sha256>`, under the
owning Project prefix. Both require owner access; icons are not arbitrary file
reads and a stale revision is rejected.

Electron's background catalog scan retains cached entries and open windows when
an individual Project cannot be checked, while continuing to update other Projects.
A structured `project_unavailable` / `starting` HTTP 503 receives a 30-second
per-Project grace period; continued startup failures are then reported. Failed
Projects, access errors, other HTTP errors and request timeouts remain visible
immediately, with the Project/request operation in diagnostics. Explicit app opens
still reject on startup errors; the grace period applies only to background scans.
The existing 10-second GET timeout and polling cadence are unchanged.

The framework does not install app dependencies. Frontend dependencies must be
bundled. Node uses the host runtime (including Electron's Node mode); Python
must be available on PATH. Use `SHADOW_APP_DATA` for persistent files, not the
temporary script directory. Backend stdout/stderr are drained, not persisted.
During startup the host recognizes missing-dependency and syntax-error signatures
using bounded transient text, then reports only a fixed diagnostic category in
the startup error. It does not expose raw output, module names, tokens or payloads.
This helps distinguish author-directory success from packaged-runtime failure;
it is not automatic dependency installation or a substitute for app health checks.

SDK `request('/backend/...', options)` preserves the query string, body and
application request headers, including custom headers such as `X-Language`.
The host supplies the backend's `Authorization` rather than forwarding the
browser access credential. Cookies, `Host`, `Origin`, `Referer`, HTTP framing,
hop-by-hop and `Connection`-nominated headers, `Proxy-*`, `Sec-*`, `Forwarded`
and `X-Forwarded-*` are not forwarded. The host HTTP client generates its own
transport headers for the buffered body. This policy is discoverable through
`capabilities.backend.requestHeaders`; it is not an unrestricted HTTP proxy.
Test metadata and binary uploads through the SDK and host, not only by calling
backend functions directly.

Node backend startup installs a host-owned `fetch` dispatcher. It uses standard
HTTP(S) proxy environment configuration, otherwise the Windows or macOS system proxy,
preserving static wildcard and `<local>` bypasses. Automatic/PAC routes use native
WinHTTP per destination, with bounded, cancellable resolution. Loopback traffic
is always direct. The proxy mode is selected at startup; automatic mode reads
the current Windows configuration for each resolution. No system settings are
modified, proxy credentials copied, or TLS checks weakened. A configured PAC
failure rejects the request rather than silently bypassing it. SOCKS and
credential-bearing proxy URLs remain unsupported and fail explicitly.
macOS static routes support wildcard/simple-host/CIDR bypass. macOS PAC and
automatic discovery fail closed for non-loopback requests: configure static Web
Proxy/Secure Web Proxy or standard proxy environment variables. See
[backend proxy boundaries](channels.md) for platform limitations.
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
LLM grant (opening starts the runtime directly). The JSON response is
`{version,values}`; a new/legacy app starts at version 0 with an empty object.
State is limited to 64 KiB including its envelope, scoped to Project/app, and
preserved across runs, restarts and published code revisions. Writes require the
last read version and atomically replace the file. A stale write fails with
`app_state_conflict` (409); callers must reload and reconcile rather than retry
blindly. Invalid stored state is reported and is not overwritten or reset.
Do not persist runtime tokens, capture/playback consent or raw audio in settings.

SDK `request()` resolves to a Response only on success. HTTP failures throw
`AppRequestError` exposing `status` and `code`; malformed/non-JSON error bodies
still produce an explicit HTTP failure rather than a JSON parsing error.

Authoring can use clearly labeled, capability-free static previews. Mock layout evidence is not permission to run a backend, call a model,
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
calls, the manifest output cap and the persistent attempt allowance. Failed
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
`--node-only` sets `tools.exec.nodeOnly` in the isolated Project configuration, without
changing the normal installation or the product request. Both `prompt.json`
and `isolation.json` record the choice. Other tools remain available; external
programs should be launched directly from Node, not through OS-shell wrappers.
This tests a tool surface and scripting policy, not an OS sandbox.
Background learning is disabled in the isolated **Project** configuration.
Before any inference, the controller verifies the running learning service is
disabled and records `learning.json`; setting only the shared runtime field
does not disable Project-owned learning. Historical runs without this check may
contain background reflection calls and must separate them from author/app usage.
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
and evidence, not new publications or successful acceptance.
Recovery uses registered local session workdirs within the isolated Project;
it does not follow links or inspect remote display paths. Hidden metadata,
credential-named files and generated dependency/test-data directories are excluded.
Python environments are also recognized by a regular `pyvenv.cfg`, regardless of
their directory name, and excluded before traversing installed packages. Linked
markers are not followed and do not hide otherwise recoverable source.
For extracted wheels and Python target installs without `pyvenv.cfg`, regular
`WHEEL`, `METADATA` and `RECORD` distribution markers identify installed files.
Only paths listed in a well-formed `RECORD` within that install root are excluded;
unlisted source beside or inside packages is preserved. A directory named `site`
is not excluded by name alone. Metadata reads are bounded to 4 MiB per file and
16 MiB overall; malformed metadata fails recovery and retains the runtime.
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
the server acknowledges it. This ledger is separate from app runtime and testing controls.

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
| Creation | 30 minutes, including feedback and clarification | Explicit `review`/`request-testing` after the creation task ends, or the creation cutoff |
| Owner source review | 5 minutes, with no model requests admitted | Exact-version `request-testing`; timeout never grants testing permission |
| Author testing | 10 minutes from the first author-testing request | Includes the existing 60-second testing question, preparation and reporting |

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
revision testing requests, runtime restarts and testing retries do not reset the first
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
directory. Progress includes blocked notes and pending impact/ancestry reviews: a completed
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
| `review-work` | `workKey`; saves the current note and its context in `work-review.json` |
| `request-testing` | `appId`, exact reviewed `revision`; invokes the real owner API and starts the first testing window; can enter review implicitly from completed creation |
| `answer-testing` | `appId`, exact `revision`, current acceptance `requestId`, `option`; explicitly answers the separate owner testing question through the real owner API; stale questions are rejected |
| `open` | `appId`; writes a one-use URL to `launch.private.json`, never to logs |
| `restart` | None; restarts only this test's Shadow runtime, preserving this round's app |
| `finish` | None; stops the round and cleans only its uniquely named test directory |

After the final product input is handled and the creation task ends, use
`{"id":"inspect-1","action":"review","appId":"<uuid>","revision":"<sha256>"}`
to reserve review time before inspecting the exact source. This closes creation;
do not send it after an intermediate delivery when more product feedback remains.
An example author-testing request is
`{"id":"review-1","action":"request-testing","appId":"<uuid>","revision":"<sha256>"}`.
Requesting testing alone does not resume the author. Read the acceptance question IDs in
`apps.json`, then explicitly send `answer-testing` with the current
`decisionRequestId` as `requestId` and the selected question option (for example,
`Continue runtime testing`). An unanswered question defers testing, never grants
permission on timeout.
Read `control-result.json` before sending the next command. Finish is cleanup,
not an assertion that audio acceptance passed: inspect the actual app UI,
translation, WAV bytes, repeat runs and restart result. Artifacts preserve
sanitized task/trace/source evidence; the private launch handoff is removed.
Each subsequent round must use a new artifact directory.
`approve-work` is retired and returns an explicit error without changing the
note. Correct a goal in the Project canvas; use `request-testing` only to ask for author testing of an exact revision. Invalid Work review fields and explicit owner API rejections write
`control-result.json` with `done:false` and an error, without destroying the
isolated runtime and its draft. Inspect it and submit a new command ID; the
rejected command is never retried automatically. Network failures, malformed
server responses and uncertain outcomes still fail the round rather than
pretending the testing request succeeded or replaying a request.
An A2A message or note/impact review does not grant author-testing or device
permission or change progress automatically. Published versions open directly.
`bundles/<app-id>.json` preserves the final immutable source bundle before
test cleanup; it is not an installed app or an execution authorization.

Framework fixture tests and a successful app registration do not establish
audio quality, real device routing, dependency compatibility or production
release readiness. Record any blocked prerequisite separately from framework
behavior.
