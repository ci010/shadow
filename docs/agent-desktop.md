# Isolated agent-desktop backend

The native backend bridges the **existing ComputerDesktop contract**:
list, bind, observe, release, and all eleven existing
operations. It does not expose agent-desktop's other commands. This is the sole
default Windows backend; no environment switch or legacy backend fallback exists.
Missing or incompatible native artifacts fail closed. Real desktop acceptance
remains a separate verification gate.

## Capability / verification boundary

| Area | Implementation | Verification so far |
| --- | --- | --- |
| Filtered window list/bind/observe | UUIDs, process generation, selected root identity, password-first tree | Compiled; pure/mock tests; actual provider checks pending |
| Window screenshots | Upstream ExactWindow, WGC then same-HWND PrintWindow, bounded PNG | Source audit/build; real capture pending |
| UIA actions | invoke, set_value, toggle, select, scroll; single exact pattern, no per-action prompt | Compiled; pure/mock receipt tests; real actions pending |
| Foreground | click, move, drag, wheel, press_key, type_text via independent AOT guard | Compiled bridge under review; fake input and idle lifecycle tests; real input pending |
| IPC/build | Dedicated Node process, strict wire checks, isolated Rust owner, native release-only ABI loop | Actual Node and Electron-as-Node loading and relocation tests |

Authorization still belongs to `ComputerService`: exact selected window, local
owner/Project/session, grant expiry and fresh single-use observations. All actions
execute as ordinary tool calls within that target; consequential actions requiring
confirmation use the existing agent `ask` flow before dispatch; applications may still activate a window in response. Loading a skill, installing Rust or selecting this
backend is not permission to act. Unknown outcomes revoke access and are never
replayed. No actual UI test has been run through shell/UIA commands.

## Process boundary and implementation

```text
Ordinary computer tools -> ComputerService -> backend factory
  -> private stdio Node child
     -> responsive JS main: validation / quick cancellation only
     -> JS Worker -> napi-rs -> dedicated Rust COM/DPI owner thread
        -> pinned WindowsAdapter / exact UIA patterns / window screenshot API
        -> independent AOT input guard process for guarded physical actions
```

The Shadow backend and Electron main process never load `.node`. The child main
isolate loads only identity and the nonblocking `cancelInput` control export;
COM/provider requests stay on the Worker/native owner. Native/guard exceptions,
raw text, key payloads and stderr are not copied into diagnostics. The worker
rejects concurrency rather than queueing, bounds messages, checks identities and
receipts, and never retries a dispatched action after timeout, cancellation or
crash. The plain-JS action schema is an exact tested erased mirror of the host's
`contracts.ts`, including modifier/key/text/coordinate restrictions.

Upstream is Apache-2.0 revision
`5a2c9ad43e269164a8adc8978a733c40b1d38a8b` (0.10.1).
`integrations/agent-desktop/README.md` records reviewed entry points, local patch,
build commands, artifact hashes, dependencies and remaining gates. Upstream
ref/session persistence is not used for grants or snapshots.

### Observation, screenshots and ordinary actions

The password-first adapter extension reads secret status before content; unknown
or secret nodes are pruned. It retains real UIA geometry and pattern support,
UTF-16-bounded name/value output, and fixed-size SHA-256/length fingerprints of
raw content. Offscreen nodes still participate in freshness fingerprints but do
not advertise actions. ValuePattern/TextPattern truncation is explicit; fields
whose original value reaches 2000 units cannot be overwritten. Window/root/node
identity, process creation/session/elevation/exclusion and visible/enabled checks
surround actions. Snapshots expire after 120 seconds and are consumed once.

Screenshots use `SystemOps::screenshot(ScreenshotTarget::ExactWindow)`. Its modern
and legacy window branches both remain window-scoped. Legacy uses PrintWindow,
not desktop CopyFromScreen/BitBlt; failure is `capture_failed`, not a desktop
fallback. Minimized/invalid/oversized targets fail closed. PNGs are scaled to a
maximum edge of 1600 and the encoded contract limit. Pointer actions require the
same observation's frame hash, dimensions and original bounds.

### Independent input guard

The upstream keyboard/mouse send seams use `dwExtraInfo:0` and process-local Drop;
that does not preserve held-input cleanup after a killed Node process. The bridge
therefore reuses Shadow's existing `windows-input.cs` safety guard, compiled ahead
of time as `shadow-input-guard.exe`. There is no runtime C# compilation or shell
launcher; the C# source and AOT build helper remain required.

The guard keeps marker-aware hooks, user-takeover checks, focus/client-area/
occlusion checks, per-packet validation and held-key/button release. Its only
command channel is its private creator-owned stdio, not a public service. A unique
local event **only cancels**; it cannot submit input commands. Cancellation is
latched, never reset for another action in that child. EOF and owner death remain
independent cleanup paths. Node signals cancellation without waiting on blocked
UIA and allows the guard's cleanup window before exiting; the adapter also keeps
new work blocked while an abnormal owner's guard drains.

No AttachThreadInput/activation trick, arbitrary window handle tool argument,
clipboard input or persistent key/button-down API is introduced. All physical
input still needs the owner's selected target and a validated fresh observation.

## Build and packaging

Rust was installed after explicit user authorization from official Rustup 1.29.1;
current rustc/cargo are 1.99.1. User `.cargo`, `.rustup`, user PATH and default
stable x64 toolchain persist. Existing VS2022 C++ tools and Windows SDK are reused.
No host restart or global LIB workaround was performed. Native builds need an
x64 VS developer environment with **MSVC**, not Git's `link.exe`, first on PATH.

Artifact pair:

```text
integrations/agent-desktop/artifacts/win32-<x64|arm64>/shadow-agent-desktop.node
integrations/agent-desktop/artifacts/win32-<x64|arm64>/shadow-input-guard.exe
```

The build has its own retained `Cargo.lock` and uses `--locked`; root pnpm lock is
not changed. `compileBackend` bundles the worker (including zod/action schema)
and copies only the matching artifact pair plus LICENSE/NOTICE. No Rust source,
`target`, upstream checkout, test fixture, ref store or private state is packaged.
Every Windows build requires the matching native assets and fails with an
actionable build command if any artifact or license file is missing or invalid.
Non-Windows builds omit these Windows-only assets. There is no fallback backend.

Runtime dependencies: interactive supported Windows APIs/UI Automation/D3D,
MSVC runtime, and .NET Framework 4.x with System/Core/Web.Extensions for the guard.
The C# guard remains existing Shadow code; upstream's Apache declaration is not
an automatic relicensing of it. ARM64 device acceptance, full dependency-license
audit, signatures and a production distribution remain separate release gates.

## Owner-controlled launch, then real desktop testing

The native backend is constructed when the host/project `ComputerService` starts.
Do not kill/restart the current host programmatically or use a temporary server
as a substitute authorization path.

When the implementation review is complete, the owner can save work and exit
Shadow normally, then start from this repository in PowerShell:

```powershell
Set-Location 'C:\Users\ci010-4090\Workspace\shadow'
$env:VITE_DEV_HOST = '127.0.0.1'
pnpm dev
```

`pnpm dev` builds backend/Electron and copies the artifact pair before launch.
No backend selection variable is needed or supported. Missing native artifacts
stop the Windows build rather than selecting another implementation.

For a controlled test window, `scripts/agent-desktop-fixture.ts` builds a local
synthetic WinForms application but **does not launch it**. The owner may open
`integrations/agent-desktop/artifacts/testing/shadow-computer-fixture.exe` manually.
It has input/button/toggle/list/pointer controls, a fake password, disabled and
read-only controls, and a long field; key/text console logging is suppressed.
It is not included in the application release assets. If launching the fixture is
not appropriate, the owner can open a non-sensitive ordinary application instead.

After restart and opening the window, tests must use the existing computer-use
host only:

1. `computer_setup` connect, then connect with the exact synthetic windowId if selection is needed (bind + observe).
2. Observe the tree; verify password content is absent, disabled/readonly/long
   fields do not advertise unsafe edits, and actual geometry/actions are present.
3. Execute ordinary UIA operations through the tools; inspect returned fresh IDs.
4. There is no computer-use panel or separate foreground switch. Observe
   again with a screenshot; execute physical operations using screenshot-local
   coordinates or the freshly observed edit control. Do not move/type concurrently
   unless deliberately testing human takeover.
5. Exercise normal turn cancellation, tool release and human takeover without automatic replay. Any uncertain result means stop,
   inspect the application and reacquire a fresh grant, not repeat an old action.

Actual provider/screenshots/input/held-input cancellation remain unverified until
these steps are performed through the newly started host. Shell-based low-level
checks below are only fake or metadata/idle-process checks, never desktop input.

## Focused verification commands

```sh
pnpm exec node --import tsx --test src/execution/computer/agent-desktop-actions_test.ts src/execution/computer/agent-desktop_test.ts src/execution/computer/factory_test.ts scripts/agent-desktop-input-guard_test.ts scripts/agent-desktop-fixture_test.ts
pnpm exec node --import tsx --test scripts/agent-desktop-assets_test.ts scripts/backend-bundle_test.ts src/computer/service_test.ts src/execution/computer/contracts_test.ts
node --test integrations/agent-desktop/scripts/source-test.mjs
```

Native root pure tests/build/identity commands are in the integration README.
AOT tests compile and run the existing fake input environment (40+ assertions),
actual guard metadata, and idle EOF/owner-death cleanup **without any begin/execute
lease**. They are not real OS key-release evidence. Relocation tests check actual
Node/Electron-as-Node addon ABI and guard metadata without opening a target.
No full-repository test/typecheck or production-readiness claim is made.


### Native protocol compatibility

The current `shadow-password-first-v4` worker/addon pair removes the obsolete
`foreground` permission command and `bind.foregroundInput` flag. The host executes
all actions directly as ordinary tool calls; no dedicated review protocol remains. Old v3 addons
are rejected by the v4 worker identity check; do not mix these versions.

A source-pair check can be performed without deploying artifacts or touching a
real window: build the addon with `cargo +1.90 build --locked --offline --lib`
from `integrations/agent-desktop` (or another installed supported Rust >=1.89),
then set the **test-only** `SHADOW_TEST_COMPUTER_ADDON` environment variable to
the resulting `target/debug/shadow_agent_desktop.dll` when running
`src/execution/computer/agent-desktop_test.ts`. The release-only ABI test copies
the fresh addon and production worker sources to a temporary fixture; it does
not replace installed artifacts, list/bind/observe a window, or start the input
guard. Production worker loading has no such override. Passing this check is
not release packaging, live UIA/input verification, or deployment acceptance.
