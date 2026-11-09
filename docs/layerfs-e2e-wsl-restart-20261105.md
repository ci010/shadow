# Windows/WSL LayerFS restart qualification — 2026-11-05

## Verdict

**PASS: isolated real Shadow tool E2E and Store/checkpoint recovery after closing
and reopening the official runtime/worker. NOT ENABLED: production Shadow.**
No production configuration, autostart, daemon settings or credentials were
changed; Shadow was not restarted. No old container was restarted or deleted.
No commits/pushes. Source baseline: `8254275251893d7072d21072643343edac453f26`.
This is not a host-reboot test or a UI/provider-driven agent-loop test.

## Inventory and integrity

CI010 registered workspace `shadow-b528c969`, Windows Node with Ubuntu WSL;
Docker 29.1.3/API 1.52 was already running. Six old Sandbox containers remained
Exited 255. Reused official upstream `73d974dea8a8d0b056a16dc6b2380d89438ce484`
sealed bundle `build-linux-536fe3d9169c4f61b53bd8577e958c53` and matching SDK,
not release v1.1.0. All **183** manifest file hashes were recomputed on Linux:
zero mismatches. Manifest and original build evidence are in
`.tmp/layerfs-e2e-20261105-fixed-b75311c8/` (see previous qualification report).
Daemon SHA-256 `aec83d7e35c08cfaa73129837912337ee659b03b950919a96fa4c824795cc90c`;
native addon `11f48047a28a086b28cc2fca7235447596df9eb1fd9b0455c8bb098a86520191`.

## Fresh isolated execution

Evidence root on CI010: `.tmp/layerfs-e2e-wsl-restart-20261105-a914/`.
`real.ts` derives from the prior passing harness but uses a new project, private
Windows home, root-owned mode-0700 Linux home and plain local Docker volume:

- Project id: `layerfs-e2e-restart-a914`.
- SDK project: `shadow-7ecfd992a2815adf78e307fb46f85f614751e3cd`.
- Linux home: `/home/ci010-4090/layerfs-e2e-20261105-fixed-b75311c8/linux-home-restart-a914`.
- Volume: `layerfs-e2e-restart-a914-store` (no bind options).
- Checkpoint: `120be9006dd8ddcfb7cf1a0c2453ca4a11fda4548ed0f9e6010c9abffa17d933a7`.

Command: `pnpm exec node --import tsx .tmp/layerfs-e2e-wsl-restart-20261105-a914/real.ts`,
with process-local System32 PATH precedence. Exit 0. Single-use retained fixture:
**do not replay Init against it**. `receipts.jsonl` and `run.log` retain actual
management and ordinary-tool receipts, including expected failure.

Result matrix (all PASS):

- Real LayerFSTool create, fork a/b and two mounts; official root WSL worker answering.
- Real ReadTool baseline `baseline\n` exactly 9 bytes.
- Real WriteTool then ReadTool and ExecTool `cat`: `branch-a\n` exactly 9 bytes.
- Concurrent real ExecTool calls on distinct workspace IDs: `concurrent-a` and
  `concurrent-b`, exactly 12 bytes each, no newline. Branch b baseline unchanged.
- Commit checkpoint-a and exact id in history; dirty b close is a completed
  failure, SDK `Dirty`, changed `/isolated.txt`; status still dirty, then commit.
- Clean original closes return `Unmounted`.
- Load checkpoint into new restored branch, mount and read exact 9/12 bytes;
  clean close. Windows baseline remains unchanged.
- Explicit runtime close; fresh LayerFSRuntime.open using the **same home and
  Store**, new worker answering (`startedAt` 09:50:40.624Z vs 09:50:36.808Z).
- History exposes the same checkpoint; load into **after-restart** branch and
  mount a new Sandbox #4; reads restore exact `branch-a\n` and `concurrent-a`;
  exec stdout byte count is 12. Clean close returns Unmounted, final runtime close.

No new project was used to mask recovery failure; no failure occurred in this
real E2E. No old Sandbox revival was attempted. Recovery uses persisted Store
history to create a new branch/workspace, not a promise of old handle survival.

## Minimal test-fixture fixes

The Windows focused suite initially failed two fake-SDK tests because POSIX
commands ran through default cmd.exe. Production adapters did not require a fix.
Changed only `src/execution/layerfs/bridge_test.ts` and
`src/tools/layerfs-route_test.ts`:

- Explicitly probe available `sh` and POSIX utilities, failing rather than skipping.
- Select `sh` for fake SDK execution, matching the Linux Sandbox command contract.
- Preserve Buffer output in async exec so invalid UTF-8 reaches the bridge's
  fatal decoder rather than being replaced by the Windows host text decoder.
- Retry test-owned directory removal briefly: timeout abort may leave fixture
  shell exiting asynchronously, causing Windows EBUSY. No mutation replay.

Final verification: both focused files **8/8 PASS, 0 skipped**; backend
`pnpm exec tsc --noEmit` exit 0. Logs: `focused-tests.log`, `backend-tsc.log`.
Full application/desktop typechecks were not run. One directory
`.layer-route-uhC9h5/` remains from the pre-fix EBUSY test attempt; it is a
credential-free untracked fixture, not part of the patch. No unrelated files
are included. Patch: evidence-root `windows-fixture-fix.patch` (tests only).

## Retained resources and operational boundary

Final inventory 09:53:58Z (`final-inventory.log`, PowerShell UTF-16): four new
Sandbox objects `34d004cfb85f`, `0c3ed9efc0fa`, `76ddcfdecf97`, `81dbe9cda2ee`
were Exited 255; at the earlier post-close snapshot they were still running.
No remaining worker/LayerFS daemon appeared in WSL process inventory, and no
endpoint.json remained under the scoped Windows home. Old six Sandbox objects
were unchanged. New volume, homes, evidence, and all old resources remain.
Thus Store persistence/new-worker recovery passes, but long-lived Sandbox
survival across WSL lifetime is still not claimed; later exit cause is unproven.

`SHADOW_LAYERFS_CONFIG` remains absent in Windows tool process environment.
Current `project-runtime.ts` dynamically exposes the LayerFSTool factory without
a readiness probe; discovery/loading is **not readiness**. Actual execution calls
`configuration()` and refuses absent absolute operator-owned configuration.
The focused configuration test confirms this disabled behavior. No production
UI invocation was attempted, and remote registered-workspace selection does
not itself authorize/provision LayerFS inside that remote Shadow runtime.

To activate separately, an operator must approve a durable private deployment:
choose matching sealed SDK/native/runtime bundle; provision a root WSL worker
and fresh plain Store volume/private home; arrange worker start/lifetime; write
an absolute operator-owned JSON `projects[actualProjectId]` entry with absolute
Windows sdkModule plus allowlisted LAYERFS_HOME, LAYERFS_STORE_PATH,
LAYERFS_WORKER_ENDPOINT, LAYERFS_IMAGE, LAYERFS_VOLUME, LAYERFS_DAEMON,
LAYERFS_CONTAINER_PREFIX and Docker socket; ensure System32 whoami.exe precedence;
set SHADOW_LAYERFS_CONFIG in the actual Shadow service/process environment and
validate there. Do not copy fixture project ids, reuse uncertain Init, point at
credentials, treat a stale endpoint as ready, or silently start/modify services.
Formal configuration/autostart activation was outside authorization here.
