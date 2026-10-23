# Windows computer use

**First version:** local Windows application observation and direct UI
Automation operations, with owner-approved guarded foreground keyboard and
mouse input. This is not unattended desktop control or a cross-platform/
remote-desktop release.

The capability is available by default in eligible local owner Main conversations;
there is no per-chat enable switch or manual window-sharing prerequisite. The
agent can enumerate supported windows and select the task-relevant target through
`computer_setup`. There is no Computer use entry in the composer + menu and no
idle/ready or manual window-sharing panel. During access, a small monitor-stop
button beside the composer offers **Stop all desktop access** via its tooltip
and accessible label; it disappears when access ends. No shared/access status
banner is shown. Exact-action reviews open automatically, with an additional
Stop button. Passive availability failures stay silent; failures during access
remain visible and require reload before approval.

## Use it

Use a local web/Electron conversation on Main with local execution enabled.
Ask the assistant to perform your task in an ordinary-privilege application.
The assistant selects an existing task-relevant window; you need not open the
controls or designate a window first. Application launching is not supported;
only if the requested application is absent may the assistant ask you to open it.
The assistant lists supported window metadata with
`computer_setup {action:"windows"}`, then acquires a current `windowId` with
`{action:"select",windowId}`. It can observe and propose UIA actions immediately;
you do not need to choose/share a window first. Only windows relevant to your
request should be selected or observed, not unrelated background content.
Window metadata and observations go to your configured model. Raw metadata,
trees and screenshots are transient; model replies/entered text may be retained.
Close sensitive content first; screenshots may contain secrets.

Supported UIA actions (`invoke`, `set_value`, `toggle`, `select`, `scroll`) execute
directly on the task-selected target without a per-action prompt. For foreground
keyboard/mouse actions, choose **Approve once** or **Reject action**.
There is no separate keyboard/mouse switch: guarded foreground actions are
available on the agent-selected target and still need the same exact-action
review. UIA remains preferred. No manual window selector is shown. Use the small
**Stop all desktop access** control beside the composer (or in a review) to revoke
access immediately; it does not close the application.

Selecting grants access to one window for at most 10 minutes. Supported UIA
modifications execute directly; foreground input requires a single-use, 60-second
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
exact-action review, never an automatic retry/fallback after UIA fails.
There is no shell-input or desktop-wide screenshot fallback.

Fields whose observed value reaches the 2,000-character limit cannot be replaced.
Some UIA providers truncate long values themselves, so comparing a value hash
does not establish that the entire underlying document is unchanged.

## Keyboard and mouse

UIA remains preferred whenever it exposes the needed operation. Keyboard/mouse
operations are bound to the selected window and expire with its grant, without
a separate opt-in. The model cannot approve input or hold keys/buttons across
actions. **This is not an isolated desktop:** foreground actions can activate
the application and move the user's real pointer. Input-interference checks
stop further injection on takeover, but cannot undo already delivered input.

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
in the grant only to construct a review. When a screenshot is requested,
one screenshot is retained **in memory** for at most two minutes as the current
observation, then only for the pending review (at most 60 seconds). Approval,
rejection, timeout, cancellation and Stop drop it. The owner/request-scoped PNG
endpoint uses `no-store`; the renderer revokes its Blob URL on review expiry,
decision, error, scope/visibility change and unmount. Observations without screenshots do not retain image bytes.
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

The sole Windows backend is native agent-desktop. The backend factory creates
an isolated Node stdio child through `stdio-transport.ts`; the main backend and
Electron main process never load the addon. The child validates wire requests,
loads the napi-rs addon in a Worker and runs UIA/COM on a dedicated native owner
thread. There is no backend selection environment variable, PowerShell launcher,
runtime C# compilation or fallback backend. Missing or incompatible native
artifacts fail closed.

Foreground input uses the independent AOT `shadow-input-guard.exe`, built from
`windows-input.cs`. Its private stdio, marker-aware hooks, bounded lease,
held-input release, EOF and owner-death watchers remain independent of blocked
UIA. Sticky named-event cancellation stops input before bounded worker teardown;
it cannot submit input or be reset for another action. No TCP listener or
Electron preload capability is introduced.

The native helper binds opaque targets to process generation and window/root
identity. Bounded password-first snapshots (200 controls, 32,000 serialized bytes,
depth 20) include runtime identities and hidden hashes of original values.
Freshness is checked before each operation; observations are consumed once.
This is not a comparison of hidden application state. Screenshots use upstream
ExactWindow capture: WGC may fall back only to PrintWindow on the same HWND,
never desktop capture. Output is bounded to a 1600-pixel longest edge. An
`executed` result is not a business-success receipt; `verified` only checks
immediate value/toggle/selection/scroll state.

Windows builds require and copy the matching native addon and AOT guard plus
LICENSE/NOTICE. Missing or invalid assets produce an actionable native build
error. The C# guard source/build helper remain; test fixtures and native private
build state are excluded from release assets. See `agent-desktop.md` and
`../integrations/agent-desktop/README.md` for build prerequisites and details.

## Verification boundary

Focused pure/mock tests cover authorization, immutable/single-use decisions,
expiry, cancellation, unknown outcomes, strict HTTP inputs, tool routing and
transient observations. Rendered Electron tests use synthetic HTTP data.
Native source/build, isolated Node/Electron-as-Node ABI and relocated packaging
tests do not establish real provider, screenshot or input acceptance.

The retained guard fake environment tests packet layout, Unicode, screenshot
mapping, focus, interruption and held-input release without calling SendInput.
Metadata/idle lifecycle probes do not begin an input lease. These tests are not
evidence of actual OS key/button release.

`scripts/agent-desktop-fixture.ts` builds a synthetic WinForms application from
`src/execution/computer/testing/window.cs` but does not launch its GUI. There is
no legacy opt-in shell-driven UIA/foreground test command. For real acceptance,
the owner must separately authorize any normal host restart, manually open the
fixture or another non-sensitive application, and use the existing computer-use
host to select the exact window. Observe password pruning and field constraints;
verify direct UIA actions without review. Obtain a fresh screenshot and approve
each physical action; no separate keyboard/mouse switch is needed. Test
Stop/human takeover only on an idle desktop under controlled approval. Unknown
outcomes require inspection and a fresh grant, never automatic replay. Detailed
steps and fixture location are in `agent-desktop.md`.

Real UIA provider behavior, screenshots, all physical actions and held-input
cancellation remain separate acceptance gates. These tests do not establish
compatibility with Office, third-party editors, every UIA provider, physical
multi-monitor/DPI configurations, enterprise host policies, signing/installation
or real-model task success.

## Observation diagnostics

`desktop_unavailable` means the native gate could not verify the interactive
Default desktop. Its bounded reason distinguishes `desktop_session`,
`desktop_open`, `desktop_name`, and `desktop_not_default`. None alone proves the
user has locked the screen: access/session/secure-desktop conditions can also
prevent verification. The gate still fails closed.

`observation_failed` means restricted UI Automation verification failed, not
that the screen is locked. Static `uia_*` diagnostic codes distinguish client
initialization, root/identity acquisition, tree navigation, deadline/budget,
process/geometry/state verification, value/text reads, and password checks.
`uia_root_protected_or_unknown` includes an unreadable/unsupported root password
property; it must not be worked around by assuming the root is nonsecret.
Unknown failures use `uia_verification_failed`. Provider exception text, window
names and values are never included in diagnostic reasons. No partial result,
screenshot-only bypass, broader access or automatic action replay is introduced.

Successful listing and selection do not prove that observation will succeed:
bind reads root identity, while observe additionally walks and verifies the
password-first subtree. The reported VSCode observation failure has not yet been
reproduced with these diagnostics; its specific native cause and live recovery
remain unverified. Rebuild the matching native addon and backend, then use a
fresh computer-use worker to obtain the new code through the authorized tools.
Old workers/addons may still return the generic `unavailable` code, which no
longer asserts that the desktop is locked.
