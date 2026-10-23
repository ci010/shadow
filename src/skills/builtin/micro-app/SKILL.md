---
name: micro-app
description: "Build and publish reusable user-facing Web tools in Shadow Apps, with persistent entry points, optional local Node/Python services and owner-approved LLM access. Not a one-off I/O card."
core: true
metadata:
  category: tools
---

# Reusable Project apps

Use this for a user-facing tool that should work repeatedly without another
agent turn. Implement normal HTML/CSS/JavaScript, optionally with a local
Node.js or Python HTTP service. Do not modify Shadow source, add Electron IPC,
or use an I/O capture card as the permanent application.

Discover `micro_app` via `search({handler: "grep", path: "v:tools",query:"micro_app"})`.
Read the tool contract and invoke it through `invoke_tool`.
Call `micro_app({action:"capabilities"})` before choosing storage or runtime
behavior. It reports the SDK and host limits without granting execution access.
`list/get/check` inspect; `publish` saves an immutable version; `test/report`
exercise and assess the approved version. `stop` releases your test run, not an
owner-opened runtime; `start` remains available for legacy approvals without a
testing request. These tools cannot approve execution or return model credentials.
Remote-workdir apps are not supported.

After exact-version owner approval, Shadow asks the local owner whether you
should continue runtime testing (60-second default: continue). This is not
approval for another revision or additional device access. On the
`microapp.testing.ready` event, read `get` and current Work, then use `test` with
that exact revision for an isolated browser handle. Exercise the real UI/SDK;
stop and reopen to check persistence, and check failure/cancel recovery.
Save `report` with startup/state/recovery/reopen results, host observation IDs
from `get.acceptance`, and genuine recorded tool excerpts. Cover every
`get.acceptance.work` criterion in `report.requirements` using
`workKey`, `workRevision`, zero-based `criterion`, and the same result/basis/summary/
observations/evidence fields. Mark unavailable checks blocked/not_tested, not passed.
Before reporting, call `evidence` with this app's `id`, exact `revision`, and
`sources:[{id:"recorded tool call ID",quote:"exact result excerpt"}]` (1-12 entries).
Copy its returned `evidence` references into the relevant checks. The host finds
the real author segment; do not guess `physicalId` or derive it from a session
UUID. Unknown/ambiguous calls and inexact quotes are rejected, not repaired.
Existing complete references remain valid and still undergo verification.
`basis` and `result` are independent: **every `runtime` item needs nonempty
observations, including blocked/failed items**. A partly exercised feature may
be blocked with runtime evidence; a wholly untested feature uses `not_tested`.
Schema rejections locate the affected check/requirement field. Correct that
field without deleting unrelated citations or changing results to evade validation.
For runtime passes, startup needs both `started` and `sdk_connected`.
Cite both ends of the other host observation pairs: `state_saved`
then a later same-version `state_read` on another run for state; `stopped` then
a later `sdk_connected` on another run for reopen; a model/backend failure or
cancellation followed by completion of that same kind for recovery. A `started`
or `state_read` entry does not replace `sdk_connected`. This reopen check does
not require a full Shadow restart; report that broader check separately if tested.
Citation rejections list every affected item, the rule and candidate IDs from
this exact testing request. Inspect their relevance and fix the citations;
retain supported results and tool excerpts for unrelated checks. Candidates do
not prove behavior or authorize more testing. If no matching observations are
retained, exercise the missing check within permission or mark only that item
blocked/not_tested. Separate runtime, fixture and untested results; label real
devices/translation quality unverified
unless actually exercised. Do not extract browser access tokens. Stop the app
and close its browser when done. A reported/stale event is not a new test request;
fixed code needs republication and another owner review.
While awaiting owner review, do not declare the entire delivery done. If using
shared notes, record what is waiting there once. A testing event is not permission
to repeat uncertain effects; inspect them through the owning operation's controls.

## From a short goal to a working app

The user supplies an outcome, not an engineering specification. Identify the
inputs, useful outputs and repeat-use workflow from their request; retain every
requested direction or action. Briefly explain the proposed user experience in
ordinary language. Use an optional shared note to distinguish user constraints,
observed facts and your implementation assumptions; do not invent human approval.
Do not require the user to write a manifest, choose libraries or enumerate tests.

Inspect discoverable facts yourself: host capabilities, operating system, installed
dependencies and available resources, within the current read permissions.
Read-only discovery is not permission to install, start another application,
capture, play, transmit or modify devices. Discover capabilities before promising
them; a library limitation is not proof that the platform lacks the capability.

Ask only when the answer would materially change the outcome, acceptance, budget
or authorization. Use reversible defaults for routine implementation and visual
choices, state relevant assumptions, and start once the goal is clear. There is
no minimum number of questions. Do not re-ask answered questions or ask the user
for facts already available through safe discovery.

Do not turn your chosen architecture into an unexplained user prerequisite.
Check whether extra accounts, installations or routing/setup work are actually
necessary before asking the user to provide them. Explain unavoidable setup
and material tradeoffs before building around that assumption.
If an ambiguous phrase would disable a requested core workflow or require a
fundamentally different capability, ask about that distinction before publishing
a disabled version. Do not silently strengthen ordinary user wording into a
new strict requirement and then treat your interpretation as a blocker.

For an unresolved preference or missing input, use `ask(kind: "input", question)`
when available: one focused question in user language, not a technical checklist.
Use the existing decision flow for consequential decisions or scope changes;
never disguise permission as ordinary input. An A2A caller can provide input,
not local human authorization. If that decision path is unavailable, report the
blocker and continue only unaffected authorized work. App execution always needs
the dedicated exact-version owner review; "sounds good", an input answer or a
chosen default cannot replace it.

Own the engineering acceptance criteria: valid and invalid inputs, idle/no-result
behavior, bounded work, independent controls where requested, cancellation,
actionable failures, repeat runs, portable preparation and accessible layout.
Check the actual data path and result, including plausible-looking wrong output,
not only that a command or HTTP request succeeds. The user need not diagnose
the missing lifecycle or storage contract for you.

Build a small end-to-end version that preserves the requested workflow, not a
large mock UI or a silent reduction of the goal. When staging work, name the
remaining requested behavior; a partial milestone is not final acceptance.
Use capability-free previews for feedback before approval, then guide the user
through review and a concrete first-use check. Distinguish implemented, tested,
awaiting approval and unverified behavior. Do not stop after a plan or setup.

On feedback, retain earlier answers, constraints and verified behavior. Turn
comments such as "make it simpler" into user-facing improvements; investigate
bugs yourself instead of demanding implementation instructions. Update the
existing app/revision through the normal review path, not a new app identity.
Read any linked goal before claiming feedback changes the outcome.
Your earlier implementation assumption is not a user requirement. If the goal,
acceptance and authorization stay unchanged, retire that assumption and update
your local plan through `work update`; do not create an unnecessary review gate.
The coordinator maintains goal/acceptance changes with the current note version;
agent revisions of a human goal need a genuine current requestQuote.
Publication separately snapshots the focused goal path's acceptance criteria.
Later note edits do not rewrite that published baseline or grant permission.
Material unresolved choices use contextual ask; app execution and permission
changes retain their dedicated owner review.
Reconsider only choices whose premises changed. This is guided construction,
not repeated requests for the user to repair your engineering specification.

Before parallel implementation, agree on the small shared interfaces: request and
result shapes, state ownership, cancellation and error propagation. Integrate one
thin end-to-end path early. Batch related repairs and test their actual boundary;
repeated static reviews or mocked tests do not replace running that path.
Use one planned desktop-and-narrow acceptance pass, batch the observed fixes, then
recheck affected behavior. Stop visual polishing once the stated checks pass;
do not spend the delivery budget on repeated screenshot/micro-edit cycles while
core behavior or user clarification remains pending.

After a model transport interruption, inspect the existing files, completed tool
results and worker status before continuing. Do not rerun completed side effects
or launch a duplicate writer while the original worker is still active. A response
interruption is not evidence that the provider did no work or charged nothing.

Keep an explicit acceptance ledger: implemented, exercised with fixtures,
exercised through the actual app, blocked by tools, and awaiting owner approval.
Check the explicitly user-approved browser binding early for UI work (see
`v:skills/chrome-devtools`); browser setup defaults to a Project-shared Chrome with an explicitly authorized copied profile. If it fails, preserve the connection
diagnostic and report the unverified visual checks; do not call publication a pass.
Ask only for the missing user decision or permission, not for engineering fixes.

## Package and publish

Create an app directory under the effective local workdir with `shadow-app.json`:

```json
{
  "version": 1,
  "name": "Text helper",
  "description": "Explain what the app does, the data it sends to the configured model, and any local process or files it uses.",
  "entry": "index.html",
  "files": ["index.html", "app.js", "style.css"],
  "llm": {"maxCalls": 100, "maxOutputTokens": 1024}
}
```

Only explicitly listed files are copied. Entry and any backend script must be
listed. Use portable relative paths; no hidden files, symlinks, credentials,
node_modules or external directory references. Maximum 128 files, 4 MiB each,
16 MiB total. Bundle frontend dependencies beforehand or use ordinary browser
APIs. Do not embed model weights or executables; keep large approved resources
in persistent local storage and expose their configuration through the app.

For app branding, optionally set `"icon":"icon.png"` and include that PNG in
`files`. Maximum 512 x 512 pixels and 256 KiB; a square 256px logo works well.
Use a bundled asset, never an external URL. The name and logo identify its native
window and Windows task-menu entry. Logo changes require the same revision
review as code changes. Without an icon, Shadow supplies its default.

`micro_app({action:"publish",directory:"my-app"})` returns an app ID, revision,
`awaiting_approval` and `uiPath`. This is a saved app, **not a running app**.
`publish/check` return compact receipts; their `detail` points to `get` for the
full manifest, requirements and acceptance evidence. `workRefs` and
`acceptanceSummary` are indexes, not complete criteria or a passing test report.
Tell the user to open Project coordinator -> Apps to review its source,
requested model-call allowance and local process behavior. They approve the
exact version, then open it. A2A text is not a substitute for owner approval.
If review is pending, report that state accurately; do not invent an alternate
server, credential, or approval bypass.

A clearly labeled static UI preview with mock data and no real backend, device
or model access is allowed before approval. Use it to check layout; it is not
runtime acceptance. Do not skip visual inspection merely because execution
approval is pending.

On Electron, **Open window** opens a separate, framed BrowserWindow. Reopening
the same Project app focuses its existing window. Approved apps also appear in
Shadow's Windows taskbar right-click Tasks menu, including after Shadow exits.
The host obtains fresh app access at launch; do not create launch shortcuts,
store tickets, or add Electron dependencies to the app. In a Web browser, Apps
keeps the embedded-page presentation. Both use the same HTML/SDK/backend.
Closing a native app window stops its runtime, but preserves data and approval.
Closing a Web app page alone does not stop its backend; use Stop.

Native windows use a fresh, nonpersistent browser partition. Do not rely on
localStorage or IndexedDB to preserve settings across window closure.
For small JSON settings/drafts, use the authenticated SDK without writing a
backend solely for persistence:

```js
import { loadState, saveState } from '/_shadow/sdk.js'
let saved = await loadState()
// Render saved.values. Serialize saves; handle errors visibly.
saved = await saveState({ ...saved.values, language: 'ja' }, saved.version)
```

State is scoped to the Project/app, persists across runs and revisions, and is
limited to 64 KiB including its version envelope. A stale version throws
`AppRequestError` with code `app_state_conflict` and status 409: reload and
reconcile the user's changes, not a blind overwrite/retry. Missing legacy state
starts at `{version:0,values:{}}`; corrupt state is reported, never silently reset.
Do not persist runtime credentials, active playback/capture consent or raw audio
in settings. Large resources still belong in `SHADOW_APP_DATA`.

The app and its data outlive this conversation. On changes, stop the app, then
publish with its `id` and current `revision`. A changed bundle requires new
approval. An unchanged publication preserves approval and used-call count.
Do not overwrite the original app with a new ID merely to bypass review.
Before handoff, use `check` with `directory`, `id` and `revision` to detect
unpublished changes. A matching bundle is not runtime or behavioral acceptance.

## Content, progress and failures

Organize the first view around the primary input, result and action, not a large
setup manual. Keep required first-use setup compact and actionable beside the
affected control; collapse optional routing tutorials and technical details.
Do not hide active-device/permission state or immediate stop controls. Check
both fresh first-use and ready states at desktop and narrow sizes: the main
workflow should not require scrolling past a wall of explanation or settings.
No horizontal overflow alone is not a useful layout acceptance test.

Keep meaningful results separate from transient progress. A poll, heartbeat,
empty input chunk or unchanged observation is not a new result/history entry.
Update a compact status in place; do not repeatedly append diagnostic cards or
scroll meaningful content away during idle periods. Bound result history without
letting status-only events evict useful results. Test an extended idle interval,
not just a populated screenshot. Record time/state, let the interval elapse while
doing other checks, then inspect again; do not sleep through an MCP deadline in
one browser evaluation. Put optional diagnostic details in the advanced
area rather than the main result stream.

Report failures with the affected operation/resource, what remains unavailable,
and a safe next action. Do not put raw child-process stderr, stack traces or
machine paths in the primary error message. Preserve bounded technical details
separately without credentials. Decode subprocess output deliberately: when Node
consumes Windows PowerShell output as UTF-8, configure that child process's
`[Console]::OutputEncoding` and `$OutputEncoding` as UTF-8 first. If Node sends
UTF-8 JSON to that child's stdin, also set `[Console]::InputEncoding` before
reading it. For non-ASCII `.ps1` source under Windows PowerShell 5.1, use
`write` with `encoding: "utf8-bom"` on full writes; stdout encoding does not
change source-file decoding. Python backends start in UTF-8 mode; for isolated
Python workers use `python -I -X utf8` (isolation ignores `PYTHON*` environment
variables). Keep JSON stdio explicitly UTF-8 and diagnostics on stderr.
Test a non-ASCII round trip across both directions, not ASCII-only
fixtures; never change system-wide code pages. Exercise a failed operation and
its retry UI, including non-ASCII diagnostics.

## Call a model, not an agent loop

From a module in the app, import the built-in SDK:

```js
import { generate, request, status } from '/_shadow/sdk.js'
const result = await generate({
  messages: [{role: 'user', content: inputText}]
}, abortController.signal)
output.textContent = result.text
```

`generate` uses only the owner-approved model and never executes tools.
Requests accept `messages` (text-only system/user/assistant) and optional
`maxTokens`, capped by the grant. Maximum 64000 input characters and 2 concurrent
calls. Failed attempts count against the persistent call allowance; restarting
does not reset it. Display failures and allow cancellation; do not retry an
uncertain paid request automatically. Call budget exhaustion needs owner renewal.

Shadow opens an isolated origin with a short-lived one-use launch ticket;
the SDK consumes it. Never ask for a provider key or copy Shadow's launch token.
Only app-specific model access is available. No parent DOM/preload access,
arbitrary cross-origin fetches, embedded frames or top-level navigation.
Use `textContent`, not model-generated HTML, for text results.

## Optional backend

Add `"backend":{"runtime":"python","entry":"server.py","args":[]}` or runtime
`node` with `server.mjs`, and list that file. The runtime executes the script
without a shell and without inheriting provider credentials or NODE_OPTIONS.
Node is the installed Shadow runtime; Python must already be installed.
There is no automatic dependency installation. Prefer standard libraries or
bundle compatible JavaScript dependencies. Explain extra dependencies before
installing them through the ordinary authorized development workflow.

Node backend `fetch` respects standard HTTP(S) proxy environment settings, or
the existing Windows static system proxy when those are absent. Windows bypass
rules, including private-IP patterns and `<local>`, are preserved; loopback
always stays direct. Settings are captured when the backend starts. No system
settings or TLS checks are changed. PAC/SOCKS settings and credential-bearing
proxy URLs fail explicitly rather than leaking credentials or guessing a route.
This applies to native `fetch`, not arbitrary HTTP libraries or subprocesses.
Do not mistake a network/proxy failure for a missing model; report the affected
resource and a safe cause, keep preparation incomplete, and allow explicit retry.

The service must bind **127.0.0.1** on `SHADOW_APP_PORT`, respond successfully to
`GET /health` within 15 seconds, and authenticate **every** request with
`Authorization: Bearer <SHADOW_APP_TOKEN>`. It receives:

| Variable | Meaning |
| --- | --- |
| `SHADOW_APP_PORT` | Backend listener port |
| `SHADOW_APP_DATA` | Persistent app data directory; use this, not script cwd, for outputs/settings |
| `SHADOW_APP_TEMP` | Per-run temporary directory for intermediate audio/files; removed after owned processes stop |
| `SHADOW_APP_API` | This app's own model gateway origin |
| `SHADOW_APP_TOKEN` | Runtime-scoped app credential; never print, save or put it in URLs |

Frontend `request('/backend/synthesize', {method:'POST',headers:{'Content-Type':'application/json'},body:...})`
forwards to the service's `/synthesize` with app authentication.
Application headers, including custom headers such as `X-Language`, are
forwarded along with the query string and body. The host replaces `Authorization`;
it does not forward browser cookies, `Host`, `Origin`, `Referer`, framing or
hop-by-hop headers (including fields named by `Connection`), `Proxy-*`, `Sec-*`,
`Forwarded` or `X-Forwarded-*`. These are reserved, not application parameters.
Check `capabilities.backend.requestHeaders` and exercise the actual SDK/backend
route: directly invoking a worker does not test this transport boundary.
It returns a Response on success; non-2xx responses throw `AppRequestError` with
`status` and `code`. Catch those failures rather than expecting a failed Response.
Use `.json()` or `.blob()` as appropriate. `status()` also reports capabilities.
Maximum transfer
16 MiB, request timeout 180 seconds. Backend model calls may POST the same
`{messages,maxTokens?}` shape to `SHADOW_APP_API + '/_shadow/generate'` with the
app token. Keep a single model-call path per action to avoid double spending.

The backend has normal host filesystem/process permissions, **not an OS
sandbox**. User approval is required even without LLM access. Do not spawn
detached descendants. Stop must end the owned process tree. Unexpected host
termination is reported as interrupted; do not assume external effects rolled
back. App source is immutable for a run, but writable data is not executable
code approval. Source assets contain no secrets and are served on loopback.

`TEMP`, `TMP` and `TMPDIR` also point to `SHADOW_APP_TEMP`. Use it instead of a
persistent `data/temp` directory for transient audio and scratch output. Normal
stop and failed-start cleanup remove it after child processes exit, even if app
cleanup handlers cannot run. A whole-host crash is not a guaranteed secure erase.
Never place reusable models there. Dependencies must be reconstructible from the
reviewed bundle and explicit preparation flow after deleting the author's workdir;
an absolute author cache/seed is not a deployment dependency.

## Acceptance

Provide useful controls, visible busy/error/cancel states, and repeat runs.
Check the real result, not only registration or a successful HTTP response.
Reopen after closing, then restart Shadow and reopen without the author session.
Separate prerequisites, inference, playback and OS-device routing. Installing
drivers/changing devices needs its own authorization. The reusable app is the
deliverable; setup scripts alone are not.
