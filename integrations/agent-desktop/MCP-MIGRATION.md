# Official MCP migration: lifecycle evidence and reviewed contract

Status: runtime/packaging migration implemented on the reviewed minimum lifecycle
contract: official cancellation, bounded direct-child cleanup, no replay after an
unknown dispatched result, and device blocking when completion is unknown. No
self-maintained native supervisor or official fork is introduced. See README.md
for current preparation and executed validation; the evidence below explains why
this is not a universal descendant-kill guarantee.

## Fixed upstream identity and release evidence

Repository: `vercel-labs/agent-desktop` (old `lahfir` URL redirects).
Version: `v1.2.0`; commit: `2b0a7334fc111730454b726e6800aa41cdafc093`.
GitHub release id: `434717448`.

GitHub release API returned the following **CLI**, not FFI, archives and digests on 2026-11-05. These are metadata observations, not a claim that payloads/attestations were verified:

- `agent-desktop-v1.2.0-aarch64-apple-darwin.tar.gz`: `219813428bb1ad8decae172faed05c5964a2415170df402e2786ccfa6452ba82`
- `agent-desktop-v1.2.0-x86_64-apple-darwin.tar.gz`: `d9dc50226f28d7fc86a2f5b0945f0c206dff6c31e418907749f493b6f9e773e6`
- `agent-desktop-v1.2.0-aarch64-pc-windows-msvc.tar.gz`: `d6d8643310c2c13eace2261444d9e4c0d16ca09581f38500983104903604caa6`
- `agent-desktop-v1.2.0-x86_64-pc-windows-msvc.tar.gz`: `a4199f741a441cedd349bf56c5eba01783b1261258b498efeb7ec9945220c3e8`
- `agent-desktop-v1.2.0-aarch64-unknown-linux-gnu.tar.gz`: `68e8ebbb4f80e44485d2f1cf972943a38ee43108e2e0ce56bdfa641fd1599f68`
- `agent-desktop-v1.2.0-x86_64-unknown-linux-gnu.tar.gz`: `591ae7f4a38479dc045df97e27447c0c8b530441730ab6b990e27c813162af44`

Release base URL: `https://github.com/vercel-labs/agent-desktop/releases/download/v1.2.0/`.
`checksums.txt` API digest: `c0dee09958351fcd68b7806427d060829cd2ee3d514625909cd9695dd35e3dd7`.
Before executing any payload: download with fixed hash, compare official checksums, verify available GitHub attestations against the expected repository/workflow/revision (or explicitly report absence), inspect archive paths and required adjacent executables, and record extracted-file hashes. Subsequent implementation validation downloaded/hash-checked the macOS arm64 CLI, verified its attestation constrained to this source/signer commit, and performed version plus MCP initialize/tools-list only; see README.md.

## Confirmed upstream lifecycle (all paths at the fixed commit)

- `src/mcp/mod.rs`: stdin EOF waits for admitted call threads. EOF is not cancellation. `notifications/cancelled` is routed by JSON-RPC request id.
- `src/mcp/calls.rs`: registry lock covers spawning and publishing the direct CLI child, avoiding cancellation/spawn admission races. Unix cancellation sends TERM to that direct CLI PID, waits up to three seconds, then kills/waits. Windows kills/waits directly. This does not recursively terminate descendants or establish OS ownership containers.
- `crates/macos/src/input/clipboard/clipboard_helper_process.rs:28-33`: official clipboard helper uses `process_group(0)`, escaping the MCP root process group. Its normal client-side error/deadline cleanup targets its own group. Killing the CLI is not equivalent to executing that Rust cleanup path.
- `crates/macos/src/input/clipboard/clipboard_helper_entry.rs`: helper is per operation, not a persistent clipboard owner. Its protocol validates a token/build identity and accepts an operation deadline clamped to 1–60,000 ms. It executes the operation and writes a response, then exits. That cooperative deadline is not proof of forced termination if a native platform call stalls after the parent dies.
- `crates/linux/src/input/clipboard/owner/owner_spawn.rs:83-100`: clipboard owner may deliberately live beyond a single CLI invocation. A waiter reaps it when it ends; the waiter's death does not kill it. `owner_record.rs` records owner identity/state. Do not equate persistent clipboard ownership with an accidentally leaked per-call worker.
- `src/cli_args/session.rs`, `src/dispatch/session.rs`, `crates/core/src/commands/session.rs`: `session end` seals the manifest and tears down the cursor overlay. It is not a general descendant/helper kill API. `session gc` removes ended/provably stale session data, not a process-container cleanup API. Do not run broad GC during another conversation's work.
- User applications are separate from execution infrastructure: macOS `launch_bridge.m` uses NSWorkspace and can reuse an existing application; Linux `launch_spawn.rs` gives launched apps a separate group; Windows `system/launch.rs` creates a process and closes its handles. A global kill-on-job-close tree on Windows could unexpectedly kill a deliberately launched app.

The local feasibility probe `scripts/agent-desktop-ownership_test.ts` reproduces the separate-group boundary using inert Node fixtures, without desktop actions or permission changes. It verifies a helper completes after the launcher group is terminated. The helper is deliberately short-lived and self-exits; no helper is located/killed by process name or a reused PID.

## Reviewed minimum integration (no new desktop runtime)

1. Register one reserved built-in source, `agent-desktop`, on demand through the generic MCP importer/connection. Start an absolute bundled executable with `mcp` and a host-generated fixed session scope; set private `AGENT_DESKTOP_HOME` and `AGENT_DESKTOP_AGENT_ID`. Allocate scope per authorized owning conversation/connection generation, not globally in the Project-wide catalog. Never forward workspace dotenv, user-supplied launch args or environment overrides to this built-in. Keep browser source/instance code unchanged.
2. Retain the complete official discovery/schema/results. Do not create `computer_*` replacements or rewrite official schemas. The current generic MCP client projects tool metadata and normalizes text; audit that projection and preserve official structuredContent/images for this source rather than claiming byte-for-byte passthrough today. Preserve provider-required image adaptation only at the provider boundary. Discovery, role checks and host-device authorization must precede connection/tool execution; browsing an index must not launch a server.
3. Use a host-owned device-wide FIFO action lock shared by all authorized connections on that physical device, not one lock per Project/source/session. Serialize tools/call conservatively; do not guess safe action classes from official tool names. Queued cancellation removes the waiter without starting an operation. Role/device grants remain authoritative, including remote-device routing; an unrelated local connection is never substituted for the selected device. Audit admission, dispatch, cancellation, outcome and cleanup generation without copying raw screen/clipboard contents into logs.
4. Desktop authorization must explicitly describe broad access to the logged-in user's desktop, applications, input, screenshots, clipboard and application launch within OS permissions. No window lease, Shadow-browser exclusion or custom action allowlist is promised. Consequential actions still require existing user confirmation semantics. Do not install system dependencies or alter OS permissions automatically.
5. Cancellation/timeout: dispatch the official cancellation notification once, retain the device lock while the call is draining, and classify any result lost after dispatch as unknown (never replay). A cleanup deadline must close/terminate only the directly owned MCP transport processes using verified live handles/generation, not process-name searches. Disconnect must not rely solely on EOF, because EOF joins in-flight calls. An inability to establish quiescence must not silently release the lock and admit another desktop mutation.
6. **Approved semantic boundary:** official cancellation does not prove that every helper has exited, and persistent Linux clipboard ownership is intentional. Proposed minimum contract is official request cancellation + bounded observation/cleanup of host-owned transport, explicitly reporting uncertain completion and retaining a blocked device state if quiescence cannot be established. It is NOT a guarantee that every descendant is forcibly killed. If strict all-owned-helper termination is still required, do not implement a plain SDK transport and label it safe: first review a separate native ownership design or an upstream-supported lifecycle extension. No self-maintained official fork, injected library, OS entitlement change, or custom schema restriction is proposed here.
7. On orderly disconnect, best-effort official session end may seal the private session and remove its overlay; record failures. It does not erase intentional user application/clipboard effects and is not a substitute for in-flight cancellation. Old-generation cleanup must not signal processes or release locks belonging to a new connection. Only reconnect after the previous generation has a known safe lifecycle state or explicit recovery handling; discovery must not replay calls.

## Packaging / migration scope after lifecycle review

- Add a versioned six-target CLI archive/hash lock and verified downloader; package only required executable(s), license/notice and integrity metadata. macOS must include the adjacent official helper; Linux the adjacent clipboard-owner. Missing/zero-length/hash-mismatched helpers fail packaging and runtime startup closed. Windows also uses the official CLI tar archive, not the FFI zip.
- Remove only tracked legacy addon/guard implementation and its build/install/package references in this clean worktree, including the old native repair hook. Update the old computer skill/docs and startup registration to the new source; do not preserve unsafe old bound-window safety statements. Do not delete the unrelated generic process guardian or browser implementation.
- Original `/Users/honx/Workspaces/shadow` has unfinished download/addon changes and must remain untouched. This branch is based on `origin/session` at `41972a1`. Do not copy its uncommitted changes into this migration.

## Acceptance gates before declaring implemented

- Fake stdio: initialize/tools-list pagination, full schemas, text/structuredContent/image/error passthrough, EOF with in-flight work, official request-id cancellation, hung call, transport death, cleanup failure, no duplicate replay.
- Authorization: role-denied/device-denied does not connect; source discovery is lazy; spoofed built-in config/env/args rejected; selected remote device is never silently replaced by Main.
- Lock: two sessions/Projects on one physical device cannot mutate concurrently; queued cancellation, timeout during dispatch, stale-generation cleanup and disconnect cannot double-release/admit. Uncertain quiescence enters a reported blocked state.
- Packaging: all six locked targets, archive traversal rejection, wrong digest/missing adjacent helper fail closed; installed app never resolves a PATH CLI or requires an addon/guard repair.
- A hash-verified native `--version` and no-desktop MCP initialize/tools-list smoke test on available macOS hardware; retain unknown platforms as unvalidated rather than silently disabling them. Windows/Linux native lifecycle and packaging require their respective CI/device lanes. No real desktop operation or OS permission change is authorized for this stage.

The parent review approved the explicitly limited lifecycle contract above. Native desktop-effect tests remain unperformed: authorization here covers only version and initialize/tools-list, never real desktop actions or OS permission changes.


## Implementation verification (2026-11-05)

- Fixed CLI archives and extracted CLI/helper SHA-256 for all six targets; each downloaded archive passed GitHub attestation verification constrained to repository, release workflow, source commit and signer commit. All archive pins match verified official checksums.txt.
- Native macOS arm64 `--version` and actual managed-source/importer initialization discovered 67 official tools. Zero real desktop tools/call; no OS grants or system dependency installation.
- Fake stdio coverage includes exact cancellation request id, EOF cancellation without caller abort, bounded stubborn-child termination, normal complete/error results, images/structured content, queued cancellation, post-dispatch crash/malformed response blocking a second connection, and queued-authority revocation before dispatch. Project config reload cannot replace the managed builtin. A retained stdio pipe is not authority to terminate a user-launched process.
- Replaced old transient-delivery assertions with normal official MCP history/provider delivery tests for JSONL/SQLite and Copilot Responses/Chat Completions, with and without images. Removed unused locale claims about window leases/transient observations.
- Focused regression suite: 144 tests, 142 passed / 2 pre-existing opt-in skips / 0 failures. Backend build and relocated-bundle suite: 5 passed / 0 failures.
- Root, A2A bridge, desktop and app typecheck tools passed when invoked directly. The pnpm wrapper refuses a symlinked node_modules task-state path; no safety check was disabled. Existing installed dependencies were reused read-only for verification.
- Windows/Linux/Intel native execution and real desktop effects remain unvalidated locally. No claim of all-helper forced termination or rollback of intended launch/clipboard effects is made.
