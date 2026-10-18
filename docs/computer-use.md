# Windows computer use

**First version:** local Windows application observation and owner-approved UI
Automation operations, with separately enabled, guarded foreground keyboard and
mouse input. This is not unattended desktop control or a cross-platform/
remote-desktop release.

The capability is available by default in eligible local owner Main conversations;
there is no per-chat enable switch or manual window-sharing prerequisite. The
agent can enumerate supported windows and select the task-relevant target through
`computer_setup`. Opening the composer **+ → Computer use** panel does not itself
enumerate or capture anything. A selected window keeps compact status and Stop
visible; exact-action reviews open automatically. Idle chats show no persistent
computer-use panel. Passive availability-check failures stay silent; opening the
controls checks again and reports connection errors locally. Failures during
shared desktop access remain visible and require reload before approval.

## Use it

Use a local web/Electron conversation on Main with local execution enabled.
Open the application at ordinary user privilege and ask the assistant to perform
your task. The assistant lists supported window metadata with
`computer_setup {action:"windows"}`, then acquires a current `windowId` with
`{action:"select",windowId}`. It can observe and propose UIA actions immediately;
you do not need to choose/share a window first. Only windows relevant to your
request should be selected or observed, not unrelated background content.
Window metadata and observations go to your configured model. Raw metadata,
trees and screenshots are transient; model replies/entered text may be retained.
Close sensitive content first; screenshots may contain secrets.

Review each proposed change and choose **Approve once** or **Reject action**.
For tasks needing foreground keyboard/mouse, open **+ → Computer use**, check
the displayed agent-selected target, and choose **Allow foreground keyboard and
mouse**. This separate explicit owner permission is off by default; the agent
cannot enable it. No relisting or manual selection is needed. It invalidates
old observations, does not extend access, and does not approve any action.
UIA remains preferred. Optional manual window selection is still available in
the panel, not a prerequisite. Use **Stop all desktop access** to revoke access
immediately, including another conversation's lease; it does not close the app.

Selecting grants observation of one window for at most 10 minutes. It does not
grant unattended modification: every action has a single-use, 60-second
review showing the window and exact action. Keyboard reviews show the target
control and complete key chord or text; pointer reviews show the exact screenshot
with position/drag markers. A missing, expired or undecodable review image
disables coordinate approval. Rejection and Stop remain available.
Only one conversation can hold a desktop window across all Projects at a time.
Window lists expire after 30 seconds; refresh them before making a stale choice.

Browser tasks retain the existing Chrome DevTools implementation. Common browser
processes and Shadow's Electron process are excluded from desktop selection.
Text fields, buttons, checkboxes, selections and scroll containers must expose
the corresponding UI Automation pattern. Unsupported apps/controls fail
explicitly. Foreground input is an explicitly selected action with its own
permission and review, never an automatic retry/fallback after UIA fails.
There is no shell-input or desktop-wide screenshot fallback.

Fields whose observed value reaches the 2,000-character limit cannot be replaced.
Some UIA providers truncate long values themselves, so comparing a value hash
does not establish that the entire underlying document is unchanged.

## Keyboard and mouse

UIA remains preferred whenever it exposes the needed operation. Foreground
permission defaults to off, is bound to the selected window and expires with
its grant. Changing windows resets foreground permission. The model cannot enable
it, approve an input, or hold keys/buttons across actions.

| Action | Contract |
| --- | --- |
| `press_key` | An observed focusable element, named key and optional unique `CTRL`/`ALT`/`SHIFT` modifiers; one complete down/up chord |
| `type_text` | Insert at the current selection in a focusable Edit/Document control; 1-1000 printable UTF-16 code units; Unicode `SendInput`, not clipboard replacement |
| `click` | Screenshot `x,y`, left/right/middle button, one or two clicks, optional modifiers |
| `move` | Move to screenshot `x,y` |
| `drag` | Screenshot `x,y` to `toX,toY`, left button, 100-800 ms, optional modifiers |
| `wheel` | Screenshot `x,y`, vertical/horizontal axis, nonzero -10..10 steps, optional modifiers; positive means down/right |

Keyboard keys are A-Z, 0-9, F1-F12, ENTER, TAB, ESCAPE, SPACE, BACKSPACE,
DELETE, INSERT, HOME, END, PAGE_UP/DOWN and ARROW_UP/DOWN/LEFT/RIGHT.
Text rejects control characters and unpaired surrogates; Enter and Tab require
separate approved key actions. Windows/Print Screen and Alt+Tab/Escape/Space/F6,
Ctrl+Escape (also Ctrl+Shift+Escape), and Ctrl+Alt+Delete are blocked.
The filters do not enumerate other applications' registered global hotkeys.

Coordinates use the exact returned screenshot's pixel grid, not UIA screen
bounds or desktop pixels. Native mapping accounts for screenshot scaling,
per-monitor DPI and negative monitor origins. The current window client area,
geometry and hit-test ownership are checked; covered points, non-client borders,
other windows and separate popups are not allowed. Wheel delivery still follows
Windows/application routing. A new screenshot is needed after each pointer
action. Image/tree comparison is best-effort stale-state protection, not atomic
semantic verification of an application's hidden state.

The input guard waits for a quiet desktop, refuses physically held keys/buttons,
and verifies activation/focus without Alt-key tricks, input-thread attachment
or elevation. If supported activation/UIA focus cannot establish the target,
it refuses to inject. While running, low-level hooks retain only the first
interruption category, such as physical or foreign-injected input, never key
contents or an activity history. Own injected events require an exact random-tag
match; tags survive both 32- and 64-bit input paths without relaxing this check.
Takeover stops further input and revokes access. Already queued or delivered OS
input cannot be withdrawn.

The guard tracks only its own pressed keys/buttons and attempts to release them
on completion, failure, cancellation, EOF and UIA-host death. It attempts to restore
the previous focus and pointer only if the user has not taken over and the
foreground still belongs to the operation. `focusRestored` may be false or null;
the UI reports this instead of claiming restoration. Whole-process-tree/OS
termination and third-party input interceptors remain outside this guarantee.

## What the first version does not do

- Application launching, rich-document context patching, persistent key/button
  holds, cross-window dragging, and automatic popup/dialog scope expansion.
- Password controls, UAC/elevated applications, secure or locked desktops,
  Session 0 Windows services, and remote Main/Child desktops.
- Agent-side approvals, automatic high-risk-action classification, or delegated
  desktop access for scripts, child executions, tasks and leaf calls.
- Guarantee support for every application. UIA providers can fail or hang;
  custom-rendered windows can reject or produce unusable `PrintWindow` images.
  The user must take over unsupported interactions.

The five original UIA actions do not deliberately move focus or inject input, but an
application can itself react by opening or activating a window. Recent user
input to the target delays/rejects a mutation. Checking the target's state cannot
eliminate every race with another actor. The user should stop sharing before
editing that same application.

## Privacy and recovery

Window text and requested screenshots are sent to the conversation's configured
model. **Local execution does not mean local-only inference.** Close sensitive
documents before sharing; password controls are omitted from the tree, but
screenshots and other controls may still expose secrets.

Raw observations are delivered to the next inference only. The tool
pipeline saves a summary in both JSONL and SQLite, without writing screenshot
files, raw trees or large-result spill files. The current bounded tree remains
in the grant only to construct a review. For an opted-in foreground grant,
one screenshot is retained **in memory** for at most two minutes as the current
observation, then only for the pending review (at most 60 seconds). Approval,
rejection, timeout, cancellation and Stop drop it. The owner/request-scoped PNG
endpoint uses `no-store`; the renderer revokes its Blob URL on review expiry,
decision, error, scope/visibility change and unmount. UIA-only grants do not
retain screenshot bytes after returning the observation.
Normal tool-call arguments (including entered text), generated replies,
reasoning and model-provider retention are not covered by this omission.
Do not use computer use to enter credentials or secrets.

Restart, host failure, grant expiry, session shutdown/handoff and cancelled or
failed turns revoke access. Approvals are never restored. Native calls have a
15-second deadline; a timed-out/cancelled mutation can have an **unknown** outcome.
Unknown outcomes stop the turn and revoke the grant, not retry the operation.
Saved `computer_act` calls are rejected during recovery. Inspect the application
before granting fresh access. An operation already delivered is not rolled back
by cancellation, even if the native helper is terminated.

The controls enforce this capability's authorization path, not a whole-machine
sandbox. Existing shell, arbitrary executable tools, browser automation and
same-user processes retain their own privileges. Window content is untrusted
input, not an instruction source or an approval.

## Implementation

The existing SessionManager/provider loop calls lazy `computer_setup`,
`computer_observe` and `computer_act` tools through `invoke_tool`.
`src/computer/` owns the host-wide lease and per-Project/session authorization.
Local-owner-only routes live beneath `/projects/<id>/api/computer`; mobile/device
credentials cannot authorize them. The Vue control uses those routes, not
agent messages or generic question answers.

`src/execution/computer/windows.ts` starts a hidden, isolated Windows PowerShell
process lazily and compiles the bundled `windows-host.cs` and `windows-input.cs` with the OS-provided
.NET Framework compiler. No PowerShell profile, policy-bypass switch, downloaded
module, .NET SDK or TCP listener is used. Private inherited stdio is the transport.
The helper watches its owning backend process and exits if it dies. Foreground
input lazily starts a second private-stdio process running the input guard,
independent of blocking UIA/COM calls. Its active lease is bounded to ten seconds.
Cancellation closes stdin first so the guard can release input; after a
two-second grace period the backend can terminate the UIA host. The guard also
watches its own parent and releases input independently on parent death.
Windows PowerShell/.NET/UIAutomation must be available under host policy; do not
disable policy to make the bridge work.

The native helper binds an opaque target to a process start time and window
identity. A fresh bounded snapshot (200 controls, about 32,000 serialized tree
characters, depth 20) is compared before every operation, including hashes of
bounded UIA-reported values and runtime identities. This is not a comparison of hidden
application state. An action consumes its observation. Screenshots
use `PrintWindow` for the selected window only, at most 1600 pixels on the longest
side. A returned `executed` result is not a business-success receipt; `verified`
only checks immediate value/toggle/selection/scroll state.

The backend build copies the C# source and bundled Skill as ordinary assets;
test fixtures are excluded. No new Electron preload API or second agent engine
is introduced.

## Verification boundary

Focused tests cover owner isolation, immutable/single-use decisions, expiry,
cancellation, unknown outcomes, strict HTTP inputs, lazy tool routing, and
transient observations through both persistence backends. A real Windows
WinForms fixture exercises UIA observation, window screenshots, field changes,
toggle/invoke, list selection/scrolling, password omission, stale-state and
bounded-field rejection without operating on user applications.
Rendered Electron tests exercise the control with synthetic
HTTP data at desktop/mobile widths and in English/Chinese.

The native guard also has a fake desktop/input environment covering packet
layout, Unicode pairing, screenshot mapping and negative monitor origins,
delayed focus activation/restoration, partial input, interruption and release.
It never calls `SendInput`. Normal test runs leave the real foreground test
disabled; the UIA fixture does not deliberately activate a window.

A separately opted-in foreground fixture creates its own window and checks
Unicode insertion, key chords, mouse buttons/double clicks, movement, modified
dragging, vertical wheel input, protected/non-client point rejection, and
cancellation with actual key/button release. It briefly changes focus and moves
the pointer. Only with the user's permission and an idle desktop, run it by
itself, not alongside other UI tests:

```powershell
$env:SHADOW_COMPUTER_FOREGROUND_TEST = '1'
try {
  pnpm exec node --import tsx --test --test-name-pattern='Windows foreground fixture' src\execution\computer\windows_test.ts
} finally {
  Remove-Item Env:\SHADOW_COMPUTER_FOREGROUND_TEST
}
```

These fixtures do not establish compatibility with Office, third-party editors,
every UIA provider, physical multi-monitor/DPI configurations, enterprise
PowerShell policies, installed/signature acceptance, or real-model task success.
Those remain application/platform acceptance work rather than claims made by
these tests.
