# Two-device Electron pairing

This is the trusted-network test path: one Electron installation runs **Main**,
and a second installation runs **Child**. Main owns projects, conversations and
providers; Child supplies execution on its own machine. Use matching builds on
both devices. This is not a production distributed-release certification.

Browser access and device pairing are different. **Connect browser** authorizes
a web UI; it does not register a Child or make that browser an execution node.

## Main workspace on Child

After the existing Child pairing and Main approval, Child opens the same Main
projects, conversations and application settings automatically. No second
invitation, browser login, role switch or separate HTTPS deployment is required.
The Child runtime remains an execution node and does not start a second Main.
The old Child-only status/inventory home and its navigation entry have been
removed. While the workspace is unavailable, only a small connection recovery
screen is shown, with automatic retry and a manual retry button. Execution-node
`connected` only confirms the execution transport, not workspace HTTP admission.
The recovery screen displays a bounded error code and HTTP status instead of assuming
that every failure means approval is pending. For example, `unauthorized` (401)
can indicate local gateway admission, `main_workspace_challenge_http_404` is a missing Main
workspace challenge route, and `main_workspace_approval_unavailable` means Main
explicitly reported that the credential is unavailable (not necessarily pending).
Backend `[child-workspace]` diagnostics include only stage/code/status, never the
endpoint, credential, signed proof or arbitrary upstream response body.

Device endpoints with a reverse-proxy path prefix retain that prefix for both
challenge and workspace request URLs, matching the execution transport.

To diagnose a connection failure without re-pairing, open the existing Child
installation with Main online, record the recovery screen's code/HTTP status,
and correlate it with backend `[child-workspace]` stage diagnostics. A local
401 fails before the Main challenge; a challenge failure and a tunneled request
failure are different stages. Do not create another invitation for an already
approved identity solely because the workspace probe failed.

In desktop development, `main_workspace_connection_failed` can also mean the
browser could not read the loopback response, not that Main is offline. If local
readiness succeeds but workspace requests fail with `TypeError: immutable` in
the backend, rebuild and restart Child with the response-header fix: the proxy
must copy upstream headers before the local gateway adds its CORS headers.

Approval now explicitly describes workspace access: only approve a desktop you
trust with the single-owner Main workspace. Existing approved public-key devices
use the same verified identity; credentials without a registered signing public
key cannot access this path. Revoking a device prevents subsequent workspace
requests and aborts its active streams. No device secret is exposed to Vue or
accepted as a general Main administrator bearer token.

The Child renderer uses its existing launch-protected loopback gateway. Its
backend signs a fresh single-use Main challenge for each proxied request; Main
binds admitted requests to that registered device identity. This dedicated
workspace tunnel shares the existing device listener and transport consent; it
does not add a port or expose the ordinary unauthenticated gateway. Native mobile
and ordinary browser authentication retain their separate authorization rules.
Local runtime control, pairing/cluster ingress and browser/mobile credential
endpoints cannot be tunneled; device enrollment still requires local Main access.

**Transport limitation:** the built-in trusted-LAN/VPN device listener is HTTP.
Workspace traffic has the same unencrypted transport limitation as execution
traffic. Use a trusted encrypted VPN or an existing HTTPS device endpoint; do not
expose this listener on an untrusted network. Device proof authenticates Child,
not confidentiality or a general HTTP man-in-the-middle defense. Application
files and uploads refer to Main's data, not Child's local home. Native local
computer/capture helpers are not made remotely available by this feature.

## Before starting

- Put both devices on a trusted LAN or VPN. The built-in device listener uses
  unencrypted HTTP with explicit consent on both sides. A VPN may encrypt its
  own tunnel; Shadow does not add TLS to this listener.
- Do not forward this port to the Internet or use it on an untrusted network.
  PINs, protocol payloads and remote job data traverse this connection.
  Device authentication does not make cleartext transport confidential.
- Use a private IPv4 interface assigned to Main. LAN, link-local and
  carrier-grade NAT/VPN addresses are supported. Wildcard/public-address
  binding and IPv6 are not part of this listener's setup.
- Child needs an accessible protected credential store: Windows CurrentUser
  DPAPI, macOS Keychain, or Linux Secret Service with `secret-tool`. Linux
  normally needs an unlocked login keyring and a working user D-Bus session.
  A missing or locked store fails; there is no plaintext-key fallback.
- Both applications must remain running. Closing an active Child window hides
  it and keeps its runtime and connection running. Reopen it from the Shadow
  system-tray/menu-bar icon (or the Dock on macOS); choose **Quit** in the tray
  menu to stop it. Main's window-close behavior is unchanged.
  This does not install an autostart service, configure the OS firewall, or wake
  a sleeping device. Quitting Electron, ending the dev launcher, logout or
  shutdown stops Child; window hiding is not an independent OS service.

## Pair the devices

1. Start Electron as **Main** and open **Nodes > Pair a Child device**. Select
   **Main's network address** on the LAN/VPN the other device can reach.
   **Port settings** defaults to `3124` (allowed range `1024` through `65535`).
   Acknowledge the trusted-network HTTP warning, then select **Enable device
   connection**. The regular app/admin gateway remains on its existing
   address; this action opens a separate device-only listener.
2. Select **Create invitation** on Main, then **Copy pairing invitation**.
   Transfer this single value privately to Child before expiry. It contains
   Main's address, invitation ID, PIN and expiry; encoding does not encrypt it.
   If clipboard access fails, open **Manual transfer** and select the complete
   invitation to copy it yourself.
3. On the second Electron installation, choose **Child > Continue as Child**.
   Paste it into **Pairing invitation**. Main's address appears for review;
   there is no need to enter an ID or PIN separately. Confirm the device name. Choose
   separate **Child home** and **Shared work folder** paths and acknowledge
   the execution/transport scope. Select **Pair and open workspace**.
   The Child creates its identity through its OS credential store, not in the
   renderer. The shared folder is advertised as the `desktop-workdir`
   capability after authentication.
   **Enter details manually** remains available for older Main builds with
   separate endpoint, offer ID and PIN fields. Pasting never grants HTTP or
   execution consent automatically. Invalid or expired invitations show an
   error before submission; invitation text is cleared after every attempt.
4. Under **Verify pending devices** on Main, compare the full **Device identity
   fingerprint** with Child. Check both the fingerprint and execution-consent
   boxes, then choose **Approve device**. Do not approve a mismatched or
   unexpected request.
5. Wait for a real **Connected** state and workdir capability advertisement.
   A submitted request, a locally ready Child backend and an approved registry
   record are not, by themselves, evidence of a connected Child.

Pairing authorizes the trusted Main to invoke supported Child capabilities.
Commands run with the Child user's OS permissions. Workdir routing and file
checks are not an OS sandbox, and this flow does not add per-command approval
prompts.

Before any credential reference is saved, a failed attempt can correct the
endpoint, HTTP opt-in and shared work folder while retaining the same node
identity, protected key and home. The PIN clears after each attempt. A saved
pairing or pending reference pins the endpoint/scope; retry resumes it rather
than silently pairing a different Main.

## Prove that work runs on Child

Create a small, non-sensitive text file in the Child work directory with
content that does not exist on Main. In Main's new-conversation composer, select
the connected Child workdir as the execution location, then send the first
message to create that remote conversation.

Ask the agent to read the file and execute a harmless foreground command in
that directory. Verify the returned content and working directory belong to
Child. The command must be appropriate for the Child OS, not Main's OS.
Disconnect Child and verify the remote location becomes unavailable rather
than silently executing on Main.

Remote sessions still use Main's configured provider. File access and a
foreground OS-shell command are useful first checks; do not start with remote
browser automation, inline TypeScript, attachments or background processes.
Those are not implied by successful pairing. See the
[remote locality contract](architecture.md#locality-contract) for supported
operations and remaining limits.

## Restart and connection recovery

Role/configuration and the credential reference survive Electron restart.
The protected private key stays in the Child's OS credential store. Main
persists the approved device registry and the explicitly enabled network
settings. Existing pairings do not require another PIN on each launch.

When Main restarts, Child reconnects through the device challenge protocol.
When Child restarts, it restores its existing identity. Pending approval or a
disconnected Main must remain visible as such, not as a successful connection.
An offline device does not become a local execution fallback.

Main's network setting is stored in `device-network.v1.json` beside its
cluster registry. If a saved interface disappears, Main itself still starts;
Nodes reports the device-listener error. Select the current address and retry.
Keep Main's address stable. A successfully paired Child's endpoint is pinned;
the current recovery UI retries that saved connection. Automatic LAN discovery,
endpoint migration and an explicit reset/re-pair UI are not implemented.
Restoring the saved Main address/port restores the existing connection; do not
delete identity data as an ordinary troubleshooting step.

**Turn off listener** stops this listener and disconnects its attached
Children. It is not device revocation: the trusted identity remains persisted,
so re-enabling the same endpoint permits reconnect.

To revoke a Child, use **Nodes > Remove device** in the authorized Main desktop
and confirm the device name. Main saves the revocation, disconnects that device,
and rejects its existing credentials on reconnect, including after Main restarts.
Removed devices leave the active list and remain under **Removed devices**.
Conversation history and files on Child are retained. In-flight remote work may
be interrupted; disconnecting does not guarantee that OS commands already
started on Child have stopped.

The earlier native build tested below left shell processes running when its
Child backend was force-killed. Current workdir shells use the independent
supervision and durable reconciliation described in
[crash-safe remote shell recovery](#crash-safe-remote-shell-recovery).
Disconnect alone still does not prove an outcome, and completed side effects
are not rolled back. Inspect affected files before requesting a new execution.
Other unfinished tools can run again after explicit acknowledgement; see
[stopped and interrupted work](using-shadow.md).

If removal cannot be saved, the device is still revoked in memory and disconnected.
Retry removal before restarting Main so the revocation becomes durable.
Removal is not a reset/re-pair flow; that recovery UI remains unimplemented.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No suitable address on Main | Connect its LAN/VPN first. `127.0.0.1` is only for same-machine testing. |
| Device port already in use | Pick an unused port on Main and use the resulting endpoint on Child. |
| Child cannot reach Main | Check the selected interface, port, network isolation and OS firewall. Allow only the intended trusted network; do not open public access. |
| Key-store error | Unlock/restore the OS credential store in the same user login session, then retry. Do not replace it with a plaintext file. |
| PIN rejected or expired | Create a fresh invitation on Main and submit its matching offer ID and PIN. |
| Pending approval | Compare the fingerprint on both devices and approve the correct request on Main. |
| Approved but offline | Keep both apps running; check the listener and network. Approval is not an online signal. |
| Device administration unavailable in a browser | Use the Main Electron window. Browser login cookies do not authorize device administration. |
| UI still says Child setup is unavailable | Rebuild/update and restart Electron. Vite hot reload does not update the main process or backend. |

## Verification boundary

Electron invokes the compiled backend entry as
`index.js child pair --config <absolute-config-path>` in Electron Node mode.
The bounded pairing request, including the PIN, travels through stdin, never
command-line arguments. Packaged builds use
`resources/backend/dist/src/index.js`; source-only pairing scripts are not
required. The Child status endpoint `/local/v1/child` is authenticated and
loopback-only; it is not a remote chat proxy.

The automated integration uses real local TCP HTTP/WebSocket connections,
production pairing and Child runtime code, persisted device references and
registry state, and Child-only filesystem/process work in disposable
directories. It exercises wrong-PIN/fingerprint rejection, pending approval,
disconnect/reconnect and restart. Its injected test key store is not OS
Keychain/Secret Service acceptance.

Separately, the compiled entry was exercised under Electron Node and plain Node
with a synthetic real Windows DPAPI credential, including reuse of the saved
reference. This does not establish native macOS/Linux credential-store behavior.

A companion case starts the actual Main host and creates a remote conversation
through its project-scoped HTTP API, verifies Child-backed folder/file access,
and checks provider-free command history and remote locality after Main restart.
Neither case requires a provider account or sends prompts to an external model.

Passing those checks is not a two-physical-device test, macOS/Linux packaging
acceptance, firewall validation, OS credential-store certification, or full
remote-tool parity. Run the workflow above on the intended devices and test
builds before relying on unattended operation.

### Crash-safe remote shell recovery

Remote workdir shells now use an independent Node guardian, not backend exit
hooks. On Windows, the guardian launches the system Windows PowerShell C#
controller, creates the command suspended, assigns a kill-on-close Job Object,
then resumes it. PowerShell compilation or ownership failures do not fall back
to an unowned command. On macOS/Linux, a second independent Node controller
owns a dedicated process group. A stdin gate prevents the command from starting
until the outer guardian has acknowledged its group ID. If the outer guardian
dies, the controller stops the group and saves its receipt; if the controller
dies, the outer guardian stops the acknowledged group and leaves the execution
outcome unknown. Runtime IPC closure, cancellation, the original deadline, and the
128 KiB output limit all stop the owned command tree. Windows adds PowerShell
startup overhead; locked-down environments that prohibit `Add-Type` fail
explicitly.

Child stores credential-scoped admission tombstones, bounded output, and final
receipts in `shell-executions-v1` beneath its data directory. New Main uses the
advertised `workdir.process.execute-once` and `workdir.process.reconcile`
operations; these use existing V1 job envelopes, not unnegotiated new wire
fields. Older Children must be updated for this path. Execution identity is
derived from the saved tool call and its physical session identity, then scoped
by Project. Records are retained rather than expired into permission to rerun.

A lost receipt pauses the session without fabricating a tool result or allowing
the model to retry automatically. **Continue** queries the original admission:
it returns saved output when available, otherwise keeps the outcome unknown.
It never starts a missing remote shell command. This also applies to legacy
calls without journal records, changed execution scope, and unavailable records
after history/segment changes. The user must inspect partial effects and issue a
new request if re-execution is desired. Other unfinished tools retain their
existing replay behavior, with explicit acknowledgement in the UI and resume API.
JSONL and SQLite preserve that recovery metadata, including legacy histories.
A late independent process receipt may supersede an earlier unknown-outcome
diagnostic. It never supersedes an already known terminal execution outcome.

This is not rollback, exactly-once side effects, or an OS sandbox. POSIX processes
that deliberately leave their owned process group are outside this ownership
model. The earlier single-layer POSIX guardian had a confirmed cleanup failure
when killed, recorded in the
[guardian-loss acceptance](#guardian-loss-acceptance--2026-10-03). The
[two-layer repair](#posix-supervision-repair-and-native-retest--2026-10-03)
passed the individual-supervisor and Child-plus-outer-guardian cases. Loss of
both POSIX supervision processes together, power loss and filesystem corruption
remain outside that evidence. An unavailable receipt remains unknown. The
legacy raw `process.execute` protocol is not the durable workdir-shell path.

Native release CI runs the process-owner SIGKILL, descendant-write cessation,
journal replay, project-isolation, and both-storage recovery regressions in
`src/execution/processes/guardian_test.ts`, `src/execution/shell-journal_test.ts`,
and `src/sessions/session-recovery_test.ts`.

## Physical Windows/macOS acceptance — 2026-10-03

Both directions were exercised with unchanged packaged Electron 44.1.1
application entries, separate test profiles and native backend sidecars:

| Main | Child | Result |
| --- | --- | --- |
| Windows x64 | macOS 26.4.1 / Apple Silicon | Passed the bounded checks below |
| macOS 26.4.1 / Apple Silicon | Windows x64 | Passed the bounded checks below |

The packages were built natively from the same local source, including
uncommitted changes and the packaging repairs found during this run. Their
release-manifest source fingerprint was
`24f363bb9d62794982b6e0e4b6cc59681830e474f316731ee8083ee18922b26a`.
Both native package-verification commands passed. This was not an Actions run
of an older pushed revision.

The checks covered fingerprint approval, real connected workdir advertisements,
macOS Keychain and Windows CurrentUser DPAPI, remote conversation creation,
Child-only text reads/writes and previews, Unicode filenames/content, foreground
OS commands, the Child's default shell, nonzero exit reporting, Git status/diff,
and allocation of a managed remote session directory. A deterministic
loopback-only OpenAI-compatible test provider drove the real session/tool loop;
no external model account was used. The shared-directory command results
identified `Darwin` on Mac and `Win32NT` on Windows, with their Child-local paths.

Closing either Child window kept the connection alive. Turning off the device
listener and quitting Child made existing previews and new remote-folder
requests fail with HTTP 503 rather than use Main's filesystem. Re-enabling the
listener, restarting each Child, and restarting each Main restored the same
approved node identity and existing remote conversation without another PIN.
Graceful application shutdown also released the owned control/device listeners.

Device traffic used the physical trusted LAN directly, not an SSH forwarding
tunnel. SSH forwarded only loopback renderer diagnostics for automation. Windows
needed an explicitly approved firewall exception restricted to the Mac's IP,
the test listener address/port and the tested executable. The Mac login Keychain
had to be unlocked by its user; a locked store correctly prevented pairing.
The copied-source preparation also had to exclude transient test files rather
than archive a source tree while another test was writing into it.
The test applications, local provider fixtures, diagnostic tunnel and temporary
firewall exception were stopped or removed afterward; the isolated packages and
test profiles were retained for reproduction.

These results do not certify every remote tool, real-provider behavior,
macOS Intel, installation/upgrade, Developer ID/notarization, OS services,
sleep/wake, address changes, prolonged unattended operation or arbitrary
network failures. The existing WIP locality and trusted-network limits still
apply.

### Failure and revocation follow-up — 2026-10-03

The same Windows x64 and macOS arm64 packages and source fingerprint were
subsequently exercised in both directions. No runtime code changed during this
follow-up. Each interruption probe started a foreground OS-shell command with
a descendant process that repeatedly appended timestamped records to a
Child-only test file. Starts, writes, completion markers and process liveness
were observed independently of the session transcript.

| Scenario | Physical observation |
| --- | --- |
| Cancel an active request | Both command trees stopped, writes stopped, and the session became cancelled. A new user input closed the unfinished call/result pair without rerunning the command. Reusable sessions intentionally retain an unfinished call for explicit Continue until then. |
| Remote command deadline | A 4.5-second deadline terminated both process trees before their 18-second probes completed. Main persisted an explicit `deadline-expired` result. |
| Turn off the listener during execution | Both probes stopped in this run. Main persisted `remote-node-unavailable`, reported the process state as unknown, and returned HTTP 503 for remote previews. Re-enabling the listener recovered the same identity and original session without replaying the command. This is not a packet-loss or network-blackhole test. |
| Force-kill the Main backend | Child stopped the active command tree. Restarting Main preserved the session with `interrupted` recovery metadata and did not automatically replay the unfinished tool. |
| Force-kill the Child backend | **Earlier-build defect:** both probes continued writing and reached their own 20-second completion after the backend died. Main correctly reported an unknown state and did not replay the command after Child restart. The probe's own finite duration, not Shadow cleanup, stopped these orphaned processes. |
| Remove a connected Child during execution | Each real packaged Nodes UI showed the named confirmation, moved the device to Removed devices and removed its available capabilities. The active probe stopped in this run. Remote previews and new remote-session requests returned HTTP 503 with `capability-revoked`. |
| Restart both apps after removal | The revoked registry state survived full application restart. The unchanged Child node ID/fingerprint remained offline, and its old public credential identity was refused a new challenge with HTTP 404 `credential_not_available`. History and Child files remained. The Child UI currently gives a general authentication/unavailability message rather than identifying revocation specifically. |

macOS also performed two actual Deep Idle sleep/wake cycles, one idle and one
with both directions executing. `pmset` recorded 45 seconds asleep in each
cycle, followed by the specifically scheduled wake. Both directions recovered
their existing identities and original sessions. During the in-flight cycle,
the Mac Child probe resumed and completed once; with Mac as Main, the Windows
Child probe was interrupted and Main saved an explicit unknown-state remote
error after waking. Neither command was replayed. Recovery therefore does
**not** mean an interrupted task always continues transparently. These short
cycles do not cover long sleep, overnight operation or interface/address changes.

Sleep scheduling required user-approved native administrator authorization
through a GUI helper launched by LaunchServices; SSH-launched authorization
did not present a usable prompt. The user unlocked the Mac after waking for
the real removal UI checks. Locked/hidden windows intentionally pause inventory
refresh; a direct API check is not evidence that a hidden UI refreshed.

An initially launched Windows app outlived its launcher's output pipe, causing
an Electron `EPIPE` error dialog during shutdown. The isolated test process was stopped,
then relaunched with persistent stdout/stderr log files and a waiting launcher
before the successful revocation persistence check. This was a test-launcher
lifetime issue, not evidence of failed registry persistence.

Acceptance reports, native power logs, process observations and packaged UI
screenshots were retained with the test artifacts. The two isolated test
pairings are now deliberately **revoked**, not reusable connected fixtures.
The test apps, fixture providers, diagnostic tunnel and narrow firewall
exception were cleaned up after the follow-up; no test-owned wake events remain.

### Independent-supervision retest — 2026-10-03

After implementing crash-safe supervision and reconciliation, matching native
Windows x64 and macOS arm64 Electron packages were rebuilt from the current
local source, including its uncommitted changes. Both package-verification
commands passed, and the working source still matched the accepted packages'
source fingerprint after the physical run:
`ebb90420467bbedea2f536548c21c448115b2f11811c306fcf08c97fae0525f8`.
These were native builds, not an Actions run of an older revision.

Fresh, isolated profiles were paired in both directions through the packaged
bootstrap and device-approval paths, using Keychain and DPAPI. The earlier
revoked pairings were not reset. The real session/tool loop again passed
Child-only reads/writes and previews, Unicode paths/content, explicit and
default foreground shells, nonzero exit reporting, Git status/diff, and managed
remote-session allocation.

All ten physical fault cases passed, five in each Main/Child direction:

| Scenario | Result on both Child platforms |
| --- | --- |
| Force-kill Child backend | The independent guardian stopped the command and its descendant. Restart plus explicit Continue recovered the original `execution-interrupted` receipt, not a new command. |
| Force-kill Main backend | Child stopped the command tree. Restart preserved pending recovery; explicit Continue recovered the original `cancelled` receipt. |
| Cancel active request | The command tree stopped. The pending call remained until acknowledged Continue reconciled its `cancelled` receipt. |
| Command deadline | A six-second original deadline stopped the 20-second probe and persisted `deadline-expired`. |
| Turn off listener during execution | The command tree stopped. Reconnection restored the same identity without replay; acknowledged Continue recovered its original `cancelled` receipt. |

Each probe independently checked its parent/descendant PIDs, Child-only writes,
start markers and natural-completion markers. Both processes were no longer
running within the ten-second observation bound; writes stopped, no probe
completed naturally, and each command started exactly once, including after
reconnection and recovery. In all eight pending-recovery cases, the resume API
rejected missing replay acknowledgement with HTTP 409. Both actual Main
renderers also showed disabled Continue until the checkbox was selected;
clicking it reconciled the Child-crash receipt and cleared recovery. Packaged
UI screenshots and detailed reports were retained.

Focused regressions also passed: Windows reported 65 passes and one POSIX-only
skip in the combined supervision/journal/session/client/UI-logic selection,
21 passes and one skip in the real-transport selection, and native macOS
reported 14 passes for supervision/journal/capability-shell tests. These
selections overlap; they are not independent totals or the full test suite.
The shared release preparation passed the existing typechecks and builds.

The four native applications, both local provider fixtures and the diagnostic
SSH tunnel were stopped. Process/listener checks on both hosts found no
remaining test apps or test listeners, and the scoped firewall exception was
removed and verified absent. Packages, reports and the fresh paired profiles
were retained for reproduction; those profiles are not running services.

The limitations in [crash-safe recovery](#crash-safe-remote-shell-recovery)
still apply. In particular, this does not prove rollback, exactly-once side
effects, simultaneous guardian failure, power-loss recovery or arbitrary
network-blackhole behavior. Sleep/wake and revocation observations above
belong to the earlier build and were not rerun for this revision. Real external
providers, long-running unattended operation, installation/upgrade,
notarization and macOS Intel remain outside this acceptance.

### Guardian-loss acceptance — 2026-10-03

The same native packages and source fingerprint
`ebb90420467bbedea2f536548c21c448115b2f11811c306fcf08c97fae0525f8`
were then tested with faults in the supervision layer itself, not just its Child
backend owner. The source fingerprint was rechecked after the run. Each
foreground command started a descendant writing every 200 ms, with a 12-second
remote deadline and a separate 24-second finite test lifetime.

| Child | Fault | Command cleanup | Durable recovery |
| --- | --- | --- | --- |
| Windows x64 | Kill Node guardian | Command and descendant stopped; no natural completion or writes past deadline | No independent process receipt; outcome remained unknown |
| Windows x64 | Kill Node guardian and Child backend together | Command and descendant stopped; no natural completion or writes past deadline | Restarted Child retained admission without a final process receipt; outcome remained unknown |
| Windows x64 | Kill PowerShell Job Object controller | Command and descendant stopped; no natural completion or writes past deadline | Surviving Node guardian saved `supervisor-failed`, not a successful execution receipt |
| macOS arm64 | Kill Node guardian | **Failed:** command and descendant continued past the deadline and completed their own 24-second lifetime, with 119 writes | No independent process receipt; outcome remained unknown |
| macOS arm64 | Kill Node guardian and Child backend together | **Failed:** same deadline overrun and natural completion, with 119 writes | Restarted Child retained admission without a final process receipt; outcome remained unknown |

Thus Windows passed all three tested cleanup cases; macOS failed both. The Mac
probes stopped because their deliberately finite fixtures ended, not because
Shadow recovered ownership. Protecting against Child backend loss is not the
same guarantee as protecting against guardian loss. The macOS supervision
layer still needs additional cleanup ownership; these results must not be
reported as complete crash-safe process containment.

This describes the earlier single-layer build. The repair and its separately
fingerprinted native acceptance are recorded below; the failed observations
remain historical evidence, not the current implementation's result.

Replay safety passed separately in all five cases. Each command and descendant
started exactly once. Two explicit Continue attempts per case, followed by a
third after force-killing and restarting Main, all preserved the pending
unknown outcome without rerunning the command or fabricating a tool result.
Every attempt without acknowledgement returned HTTP 409. The five recoveries
survived Main restart, and both packaged renderers continued showing the
recovery notice with unchecked acknowledgement and disabled Continue.

The test runner records cleanup and replay safety as separate outcomes, and
retains process ancestry, start/write/completion observations, journal evidence
and screenshots. No runtime implementation changed during this acceptance.
No sleep, power-loss, Linux guardian-loss or long-duration tests were performed.

### POSIX supervision repair and native retest — 2026-10-03

The additional independent POSIX controller and launch gate were implemented
without another compiler dependency, OS service or package dependency. The
controller and outer guardian provide reciprocal process-group cleanup, and
reconciliation now accepts a late authoritative process receipt after an
earlier unknown diagnostic. Admission-gate tests also kill the controller
before acknowledgement and prove that the command never starts.

Matching Windows x64 and macOS arm64 Electron packages were rebuilt and
verified from source fingerprint
`6ca340a51e04da24bb6487dd2b5db93b8570278c2bb84db9d840bab59a3e9b34`,
which still matched the working source after native acceptance. Fresh isolated
profiles used the native Keychain/DPAPI pairing path and the deterministic
loopback providers.

To avoid requiring another administrator prompt, this round used an
explicitly different transport arrangement: Windows Main listened only on
loopback, and Mac Child reached it through an SSH reverse forward also bound
only to loopback. Mac Main to Windows Child still used the direct trusted LAN.
Both directions executed on the two physical devices, but this round is not a
fresh direct-LAN/firewall acceptance for Windows Main. No new firewall exception
was installed, and the previous exception remained removed.

All six supervision-layer cleanup checks passed:

| Fault | macOS Child | Windows Child |
| --- | --- | --- |
| Kill outer Node guardian | Command tree stopped; original independent `execution-interrupted` receipt reconciled | Command tree stopped; missing receipt remained unknown |
| Kill outer Node guardian and Child backend together | Command tree stopped; restarted Child reconciled the original independent receipt | Command tree stopped; restarted Child retained unknown outcome |
| Kill platform controller | Outer guardian stopped the command group; missing receipt remained unknown | Job Object stopped the command tree; saved `supervisor-failed` remained unknown |

No probe completed naturally, wrote past its deadline, or started more than
once. Main restart preserved the two reconciled Mac outcomes and the four
remaining unknown recoveries; further Continue attempts never replayed a
command or fabricated a result. Both packaged renderers retained the explicit
acknowledgement controls for pending unknown outcomes.

The original ten cases also passed again: Child crash, Main crash, cancellation,
deadline and listener interruption in both directions. Child-only file and
preview operations, Unicode, default/explicit shells, nonzero exits, Git and
managed directories passed in the rebuilt applications. Thus this round covers
16 native fault cases, not just host-Node regression tests.

The focused Windows selection passed serially with 68 passes and three
platform skips; the native Mac host-Node selection passed all 19 cases. Shared
release preparation passed all existing typechecks/builds. An earlier parallel
Windows run hit a JSONL rename `EPERM`; its isolated 42-case session/UI-logic
rerun and the complete serial selection passed. No unrelated storage change
was made to conceal that transient failure.

All four test apps, both providers and the SSH forwards were stopped. Final
checks found no test listeners or supervisor processes on either host, and no
temporary Windows firewall exception remained. Packages, profiles and evidence
were retained; the fresh Mac Child profile requires its temporary loopback
forward and is not a standalone LAN pairing.

The two-layer design is not kernel-enforced POSIX containment. Losing both
POSIX supervisors, deliberately escaping the process group, power loss and
corrupt storage remain outside the tested guarantee. Sleep/wake, Linux native
packaging, real providers and prolonged unattended operation were not tested
in this round.
