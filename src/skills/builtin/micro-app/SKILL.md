---
name: micro-app
description: "Build, update and publish apps specifically for Shadow Apps, using its manifest, owner-reviewed runtime and optional SDK/backend. Use when the user requests a Shadow-hosted app or has chosen that delivery format. Not for ordinary websites, standalone HTML pages, UI prototypes, or existing Web projects; repeat use alone is not a trigger."
core: true
metadata:
  category: tools
---

# Shadow Apps

Use this only when the requested deliverable is an app hosted in Shadow Apps,
or the user has chosen that delivery format. A webpage, website or reusable
browser tool does not by itself select Shadow Apps. Follow the requested project
and delivery target; do not introduce app packaging, publication or owner review
into ordinary Web development. You may suggest Shadow Apps when useful, but do
not silently choose it or ask every webpage requester to choose a platform.

Build normal HTML/CSS/JavaScript with an optional local Node/Python service.
Do not modify Shadow source, add Electron IPC, or use an I/O card as the app.
Remote-workdir apps are not supported.

Discover `micro_app` through `search({handler:"grep",path:"v:tools",query:"micro_app"})`,
read its contract and invoke it through `invoke_tool`. Call `capabilities` before
choosing storage or runtime behavior; capabilities do not grant execution access.

## From a short goal to a working app

- Identify inputs, outputs and the repeat-use workflow. Preserve every requested
  direction/action; own engineering criteria rather than asking for a technical
  specification. Inspect discoverable facts; do not promise unverified capabilities.
- Ask only for material missing input or consequential choices through the normal
  ask flow. Input, defaults and A2A replies are not local human authorization.
  Discovery does not authorize installs, devices, capture, playback or transmission.
- Build a thin end-to-end version. Verify real results, invalid/empty input,
  bounded work, busy/error/cancel behavior and repeat runs. A mock or successful
  HTTP response is not runtime acceptance. Label partial/unverified work honestly.
- On feedback, retain earlier answers, constraints and verified behavior; update
  the existing app/revision. An implementation assumption is not a user requirement.
  Reassess only changed premises. Read linked goals before claiming scope changes.
- Before parallel work, agree on interfaces/state/cancellation. After interruption,
  inspect files, tool results and workers; do not duplicate uncertain side effects.

## Required references

Read only the relevant reference when entering that stage:

- Before UI implementation/inspection: `v:skills/micro-app/reference/ui-and-errors.md`
  for first-use layout, bounded progress/history, failure UX and subprocess encoding.
  Use `v:skills/impeccable` for visual guidance and `v:skills/chrome-devtools` for
  browser setup. Report unavailable visual checks, not a fictional pass.
- Before adding a backend: `v:skills/micro-app/reference/backend.md` for the
  authenticated protocol, process lifecycle, persistent/temp storage and proxy rules.
  A backend has normal host permissions, **not an OS sandbox**.
- Before runtime testing or reporting, including `microapp.testing.ready`:
  `v:skills/micro-app/reference/testing.md` for exact-version authorization,
  host observations, evidence citations and acceptance/report rules.

Publication saves an immutable version, not a running app. Execution requires
exact-version owner review even without model access; ordinary input or A2A text
cannot replace it. Do not invent a server, credential or approval bypass.
A capability-free static mock preview is allowed before approval, but is not
runtime acceptance. While review is pending, report awaiting approval, not done.

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
Tell the user to open Project workbench -> Apps to review its source,
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
