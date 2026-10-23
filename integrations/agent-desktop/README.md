# agent-desktop napi-rs addon (sole Windows backend)

Independent Cargo package; the default and sole Windows ComputerDesktop backend.
No backend selection environment variable or legacy fallback is supported. Windows
backend builds require the matching addon, AOT guard, LICENSE and NOTICE; missing
or invalid files fail with an actionable native build command. Non-Windows builds
omit these Windows-only assets. Real desktop acceptance remains pending.

Pinned upstream:
`5a2c9ad43e269164a8adc8978a733c40b1d38a8b` (Apache-2.0).
Windows x64 release compilation and pure tests pass. **No actual UIA enumeration,
observation, action, capture, input or fixture-window launch was performed.**
Source/build results are not live provider safety acceptance. ARM64, signing,
dependency-license review and distribution remain unverified.

## ABI / existing ComputerDesktop wire

- `identity(): string`: pure JSON, protocol 1, backend `agent-desktop`, pinned
  revision, patch `shadow-password-first-v4` (requires matching worker/addon; old v3
  permission-gated addons fail identity validation). Does not create an owner or UIA.
  Capabilities: restricted true; methods list/bind/observe/act/release; actions
  invoke/set_value/toggle/select/scroll/click/move/drag/wheel/press_key/type_text;
  screenshot/values/nodeBounds/input true; clipboard false; guard shadow-input-guard-v1.
- `request(json: string): string`: `{result:...}` or `{error:{code,reason?}}`; maximum
  request 32768 UTF-8 bytes. Reasons are allowlisted static diagnostic codes;
  no raw provider diagnostics/content in errors. UIA verification errors use
  `observation_failed` + `uia_*`, distinct from `desktop_unavailable` +
  `desktop_session`/`desktop_open`/`desktop_name`/`desktop_not_default`.
  Unclassified `unavailable` errors must not be presented as proof of locking.
- Worker injects `ownerPid:process.ppid` and fixed sibling `guardPath`, rejecting external fields. Native state
  pins the first owner PID and guard path. Load only in a disposable worker process, never Main.
  Host authorization remains required before bind.
- `list {processId?}` -> `{windows:[{id,title,app,pid}],excluded}`.
- `bind {windowId}` -> `{id,title,app,pid,bounds}`.
- `observe {targetId,screenshot:boolean}` ->
  `{id,targetId,title,bounds,elements,truncated,screenshot?}`. Elements:
  `{id,parentId,role,name,value?,enabled,offscreen,protected,focusable,bounds,actions,toggleState?,selected?}`.
  Screenshot: `{mime:'image/png',base64,width,height}`. Maximum edge 1600;
  **base64 itself** <=4 MiB (PNG <=3 MiB). Source bounds: <=8192 per edge,
  <=16 million pixels. Failure is an error, no substitute desktop image or
  partial observation. ValuePattern values or password-first bounded TextPattern DocumentRange.GetText(2001); legacy values are omitted.
- `act {targetId,observationId,actionId,action}` where action is one of:
  `{kind:'invoke',elementId}`, `{kind:'set_value',elementId,value}`,
  `{kind:'toggle',elementId}`, `{kind:'select',elementId}`,
  `{kind:'scroll',elementId,direction:'up'|'down'|'left'|'right'}`.
  Scroll is one SmallIncrement/SmallDecrement on one axis. Receipt:
  `{actionId,outcome:'executed',verified:boolean,observation}`. Invoke returns
  verified false; other verification is immediate UIA state, not persistence.
- `release {targetId}` -> `{released:true}`; removes target and snapshot.
- Internal `shutdown` joins the owner thread, irreversible for that addon load.
- Keyboard/mouse actions use the bound target without a separate foreground toggle.
  The host requires exact review for foreground input; supported UIA actions run
  directly. Native focus, protected-target,
  geometry and input-interference checks remain mandatory.
- `cancelInput(): void` is independent of the owner request queue. A permanent atomic
  latch plus Arc-owned named manual-reset event stop the guard even during blocked UIA.
  Cancellation requires disposing/rebuilding the Node instance; it is never reset.
- Clipboard, launch, physical pattern fallback and every unlisted action remain unsupported.

## Safety implementation

`src/windows.rs` retains the Default input desktop/nonzero-session gate,
owner/self exclusion, same-session PID, browser/Shadow/Electron/Node exclusion,
fail-closed token-elevation query, HWND visibility, creation-time and process-image
checks. Enumeration failure is not an empty success. Candidate UUIDs expire in
30 seconds; list invalidates candidates; bind consumes its UUID, records UIA root
runtime ID and caps active targets at 32. Observe corroborates title, bounds,
HWND/PID/generation/root before/after. Minimized windows fail closed.

`patches/shadow_observe.rs` compiles inside the real WindowsAdapter crate. A locally
owned COM client has connection/transaction timeouts. The walker is password-first:
unknown password status is protected and the node/subtree is pruned; a protected
or unknown root fails. No secret name/value/children are read, no bulk cache or
label read occurs. Every visited node must have the bound PID; geometry uses
checked integer endpoints. A post-content password check discards raced reads.
Role, focusability and supported patterns are read after classification. Nonsecret offscreen
names/values are also observed and fingerprinted; only actions require enabled/onscreen. SetValue is advertised only
for writable Edit values with original UTF-16 length strictly below 2000. Long
values mark truncation and cannot be replaced. Input values <=4000 UTF-16 units,
no NUL. TextPattern fallback is read-only and never advertises set_value. Legacy values remain omitted. Walker limits: 200 nodes, depth 20,
32000 serialized bytes (conservative relative to old host's character count),
five-second cooperative deadline.

Snapshots are native memory only, eligible for action for 120 seconds, replaced
by observe. Act removes the old snapshot before validation: one-use even on
failure. UUID-shaped action IDs are reserved before freshness checks and cannot
replay during the worker lifetime (cap 10000). Fresh signatures include title,
bounds, full tree order/structure, role/name/value, enabled/offscreen/focusable,
pattern actions, toggle/selection, truncation and hidden SHA-256 fingerprints and UTF-16 lengths of original names/
values + runtime IDs. Full original strings are not retained in snapshots. Hidden metadata never enters wire observations. Node IDs
map to the specific snapshot's runtime IDs only; a fresh observation must match
the entire signature and binding. Reacquisition scans only the authorized
password-first subtree and rechecks PID/root/element runtime ID. Snapshots retain
no COM interfaces.

Each ordinary UIA mutation calls exactly one pattern once: Invoke, Value, Toggle,
SelectionItem or Scroll. No foreground/focus/physical-input call on this ordinary branch. The effect flag
is set immediately before mutation. Every later error, post-observation failure
or caught panic becomes outcome_unknown; no automatic retry. A success contains
the matching action ID and a revalidated post-action observation, saved as the
next one-use snapshot.

### Upstream reuse and non-equivalent paths

Capture uses real `SystemOps::screenshot(ScreenshotTarget::ExactWindow)`:
`system/adapter.rs` -> `system/screenshot.rs`. WindowInfo carries the bound PID
and exact `windows-proc-v1:seconds:subtick` generation from the same FILETIME as
our process gate, without rounding. `system/capture_backend.rs` routes
CaptureSubject::Window on BOTH modern and legacy legs. Window legacy is
`system/capture_window.rs`: PrintWindow on that HWND, never desktop CopyFromScreen
or BitBlt. WGC failure can fall back to PrintWindow only. Root/process/title/bounds
validation surrounds capture. `image` decodes/re-encodes PNG and scales down;
dependencies affect only this Cargo manifest/lock, not the root TS lock graph.

Actions reuse the upstream uiautomation pattern layer inside WindowsAdapter,
not blindly ActionOps::execute_action: `actions/dispatch.rs::execute_click` has
an Invoke->Legacy default-action chain, value_write has policy-dependent fallback,
and `select.rs` searches names, expands and scroll-to-realizes descendants.
These are not equivalent to this wire's exact runtime-bound single-dispatch
boundary. The restricted extension deliberately does not exercise those richer
paths. Unmodified get_tree also prefetches Name/Value before IsPassword
(tree/walker_source.rs, properties.rs, property_ids.rs, cache.rs), so remains unused.

Native providers can block beyond cooperative deadlines; password properties can
race between reads as with the old host. This is not an OS sandbox or a claim
that provider metadata is trustworthy. Parent cancellation must first call cancelInput, allow bounded guard cleanup, then
terminate the disposable worker, never unload a live addon. A dedicated native thread owns COM
MTA/DPI/WindowsAdapter, serializes requests and drops local COM interfaces before
DPI restoration/CoUninitialize. No persistent interface crosses that thread.

## Reproduce Windows x64

Requires Git, Node 24+, Rust >=1.89, VS2022 C++/Windows SDK. From this directory
in an x64 VS developer shell (MSVC link.exe first):

    node scripts/fetch.mjs
    node scripts/build.mjs x86_64-pc-windows-msvc
    cargo test --lib --locked --target x86_64-pc-windows-msvc
    node --test scripts/source-test.mjs
    node scripts/identity.mjs artifacts/win32-x64/shadow-agent-desktop.node

For an existing pinned checkout use `node scripts/fetch.mjs --sync`. It verifies
HEAD, refuses non-owned lib.rs edits and writes only the owned module declaration, SHA-256 dependency declaration
and crates/windows/src/shadow_observe.rs plus shadow_gate.rs. No other upstream file/directory is
reset, cleaned, checked out or overwritten. Fresh fetch accepts a local clone as
its single argument. No upstream scripts execute. HTTPS fetch was not exercised.

To import the existing local VS helper from repository root in PowerShell:

    $lines = & cmd /c integrations\agent-desktop\target\shadow-msvc-env.cmd
    foreach ($line in $lines) {
      if ($line -match '^([^=]+)=(.*)$') {
        [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
      }
    }
    $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

Do not expand/restore an old CMD %PATH% on one command line; that can restore Git
link.exe ahead of MSVC. Normal builds use --locked; lock re-resolution is explicit.

Output `artifacts/win32-x64/shadow-agent-desktop.node` (win32-arm64 requires its
own cross-build and device acceptance). Keep outside ASAR. Check protocol/backend/
revision/patch/capabilities/architecture before load. Ship LICENSE/NOTICE and
review dependency licenses. No signing/installer/production-readiness claim.

identity.mjs only loads an isolated Worker, checks identity, sends an impossible
method rejected before desktop gates, then joins owner shutdown (10s limit).
Foreground-limited WaitForQuiet preserves the old host: target foreground requires 300ms idle, polled at most 20 times with 50ms sleeps; no activation occurs. Each action checks its deadline immediately before dispatch and after verification. Screenshot errors use capture_failed, including decode/re-encode deadline expiry. Wire roles preserve ControlType.Edit/Document/Button capitalization.

Root pure tests cover validation, UUIDs, secret pruning/runtime binding, hidden
signature changes, generation splitting, one-use maps and outcome classification.
Static source tests are regressions, not live safety proof. All real provider/
fixture capture/action tests must be separately authorized and performed by the
parent through the computer-use host; none run here.


## Foreground bridge (v3)

The six existing ComputerDesktop foreground actions are supported, with the
normalized `contracts.ts` fields (defaults are supplied by the host schema):
click(x,y,button,count,modifiers), move(x,y),
drag(x,y,toX,toY,durationMs,modifiers), wheel(x,y,axis,steps,modifiers),
press_key(elementId,key,modifiers), type_text(elementId,text).
Native independently validates strict keys, integer bounds, unique CTRL/ALT/SHIFT,
key whitelist, blocked system shortcuts, printable Unicode and UTF-16 lengths.
No upstream command is added and no upstream SendInput path is exposed.

Pointer actions require a previous screenshot. Only its SHA-256, dimensions and
original bounds remain in the snapshot, not PNG data. A fresh screenshot and tree
must match. Pixel-center mapping matches InputLease.Map; start/end must be in the
selected client and unobscured. Keyboard targets require matching runtime IDs,
enabled/visible/focusable/nonsecret status; typing requires writable Edit/Document.
The adapter extension performs password-first raw ancestry checks, root/PID/runtime
checks and bounded verified SetFocus only. It never uses AttachThreadInput or a
pattern fallback. Ordering is guard begin -> activation check -> necessary verified
SetFocus -> guard check -> focused observation signature -> pointer/focused ancestry
-> actual GUI thread focus HWND -> execute. Guard validates each injected packet.
Success returns `{actionId,outcome:'executed',verified:false,focusRestored,observation}`.

`src/input.rs` lazily launches only the sibling AOT `shadow-input-guard.exe` using
Command::new (no shell), with current Node child PID as its owner argument. The
host-injected ownerPid is separately used to exclude the Shadow parent process.
Each instance creates a UUID-named Local manual-reset cancellation event. A short
mutex clone keeps its handle alive through SetEvent; no lock spans UIA/IPC.
Cancellation before lazy start is permanently latched and checked before event
installation, spawn, begin and execute. Unknown IPC or failed cleanup poisons the
instance, signals the independent watchdog, closes stdin and performs bounded
wait/kill of only the owned guard. EOF and owner-death remain independent cleanup
paths. Cancel never resets for another action; rebuild the Node process.

Guard transport bounds UUID-tagged lines and validates response schemas and the
boolean effectStarted flag. The native effect flag is set before sending execute
and cannot be cleared by a later guard response. Lost/invalid replies, cleanup
failure and post-execute observation/cancellation errors are outcome_unknown;
there is no replay. FILETIME creation values convert to .NET UTC ticks with checked
addition of 504911232000000000. Handles, times and focus use decimal-string fields.

The build script calls the root builtins-only `buildInputGuard` helper after a
successful locked Cargo release build. It AOT-compiles the existing marker-aware
monitor/lease host directly, without a shell launcher. Its original physical
interruption, held-input release, client/occlusion, focus, EOF and owner watchdog
remain, plus independent named-event cancellation. Build requires Windows .NET
Framework csc; runtime requires .NET Framework 4.x (System, System.Core,
System.Web.Extensions) and existing Windows APIs. Native PE dependencies include
VCRUNTIME140.dll and Windows system/UIA/D3D libraries. The guard PE imports
mscoree.dll; its CLR host P/Invokes user32/kernel32. No new Cargo or root lock
resolution was required.

## Verification for foreground revision

- Rust production-linked pure/no-UI tests: 29/29 (validators, UTF-16, shortcuts,
  mapping, checked FILETIME, one-use snapshots/action IDs, frame identity,
  outcome classification, strict IPC, Arc event lifetime/sticky signal,
  cancellation-before-start, rejection of the obsolete foreground permission method).
- Node static source regressions: 10/10.
- Root input-guard helper tests: 4/4, including >=40 existing fake-environment
  assertions, metadata-only real guard identity, and idle EOF/owner-death cleanup.
  No begin/execute request, hook installation or input emission occurs in these
  lifecycle tests. Fake held-key release is NOT an OS keyboard test.
- Windows x64 locked release and isolated addon identity/NAPI ABI, impossible-method
  rejection, cancelInput export and owner shutdown pass without desktop calls.
- No real UIA enumeration/observe/action, capture, keyboard/mouse input, application
  launch or Shadow restart was performed. Real target acceptance must use the
  parent-approved computer-use tool. ARM64 build/device, packaging, signing and
  dependency-license review remain unverified.

Runtime artifact files (outside ASAR):
`artifacts/win32-x64/shadow-agent-desktop.node` and
`artifacts/win32-x64/shadow-input-guard.exe`.
Guard metadata source SHA-256:
`2a920e421dbfcd398e565042819aff33b3e0868bb9efe4d9e078368014cec4cd`.

Historical foreground-revision x64 artifact SHA-256 (not current after rebuild;
guard csc builds are not deterministic):

- shadow-agent-desktop.node (1310720 bytes):
  `D666F5BEF1B773D641F8B5B5ADA687BB7516E8DEE506B0CE728741110108B578`
- shadow-input-guard.exe (30208 bytes):
  `2B9DC3F8D36C0A009D6A9789DA81E8273B7C0A0193E90B8BD47AC71D206C1B2F`

Revision-2 review hardening:
- Ordinary shadow_action also consumes the sticky cancellation predicate at entry,
  every dispatch gate, immediately after successful mutation and before returning;
  native checks cancellation around post-observe. A dispatched cancellation stays
  outcome_unknown, never a successful replayable receipt.
- Typing reads ValueAvailable only after password-first classification. Only known
  absence allows no ValuePattern; known presence requires successful pattern/read-only
  queries and explicitly writable state. Unknown availability/provider errors refuse.
- Guard result schemas are exact per method inside the transport parser. Malformed
  begin/check/activation/execute/cancel responses poison before any guard reuse.
  Reply buffering uses sync_channel(1), not an unbounded queue.
- Before the owner-mode guard is launched, an owned --identity-only subprocess must
  exit successfully within three seconds with <=4096 output bytes and exact
  protocol/backend/sourceSha256 metadata. Cancellation is checked before/after;
  failed probes poison the instance. Timeout/cancellation cleans up only that probe.
- Nonsecret offscreen Name/Value/TextPattern content participates in fingerprints
  and wire fields; disabled/offscreen controls still advertise no actions.
- Additional pure/source tests cover cancellation-before-dispatch, readonly evidence,
  exact method schemas, bounded metadata parsing and offscreen signature changes.
  No real begin/execute/UI probe was used to test these changes.
