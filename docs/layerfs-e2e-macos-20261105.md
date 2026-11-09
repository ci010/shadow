# LayerFS macOS / OrbStack live test — partial failure

Later restart retest: [macOS repair evidence](layerfs-e2e-macos-restart-20261105.md).
The failures below remain historical facts. The earlier search missed official
#500 after the Rust path relocation; the statement below is corrected accordingly.
The later passing build is explicitly patched upstream, not this release tag.

Date: 2026-11-05. Final inventory: 06:16 UTC. This is a real upstream SDK,
Linux native addon, Store, FUSE and Docker test through actual Shadow tool classes.
**It is not a full passing macOS E2E qualification.** No synthetic SDK supplied
the results below. No production Shadow configuration or shared source was edited,
no Shadow restart, host sudo/admin operation, commit or push was performed.
Other contributors' existing worktree changes were preserved.

## Result matrix

- PASS — restore existing OrbStack engine: `orb status` was Stopped despite the
  app process existing; `orb start` restored the socket and Docker API.
- PASS — official pinned v1.1.0 Linux/arm64 native release build and sealed bundle.
- PASS — official macOS container worker starts and answers with real addon.
- PASS — `LayerFSTool.execute`: actual create/init, fork agent-a/agent-b,
  two successful new-sandbox mounts, checkpoint, history and load into new branch.
- PASS — actual `ReadTool.execute`, `WriteTool.execute`, `ExecTool.execute` with
  Project-bound `layerfs:` selectors; baseline text, independent concurrent writes
  and concurrent exec return `agent-a\n` versus `agent-b\n`. Dotfile imported.
- PASS — dirty close returns code `Dirty`, changed `/hello.txt`; no force/discard.
- PASS — checkpoint history contains saved ID; after changing agent-a to `newer`,
  load creates `restored` at the older checkpoint. **Diagnostic path only:** public
  upstream SDK mounts restored into already-running sandbox 2; ordinary ReadTool
  returns old `agent-a\n`. Original fixture remains `baseline\n`.
- FAIL — reliable new-sandbox creation: two attempts return `Connect` /
  `ECONNREFUSED` after daemon logs LISTEN, with explicit `removed:true`. One used
  default `host.docker.internal`; another used `host.orb.internal` after two
  successful mounts with that setting. Host alias change is not a stable fix.
- FAIL — clean close of agent-a and agent-b, each after a saved checkpoint and
  clean status, returns `Failed`, `Retained(TeardownCustody)`, stage `Join`,
  detached=true, two loops entered, zero exited/joined. Neither close was replayed.
- PASS, limited — restored diagnostic workspace alone returned `Unmounted`.
  This does not cancel the two clean-close failures.
- NOT PASSED — uninterrupted create → mount → tool execution → checkpoint/history
  → load → new-sandbox restored mount → all clean closes. Diagnostic reuse of an
  existing sandbox must not be reported as a successful LayerFSTool new mount.

## Environment repair and scope

Mac Main only: `/Users/honx/Workspaces/shadow`. Node v24.22.0;
OrbStack 2.2.5 (2020500); Docker client/server 29.8.2, API 1.56,
Linux aarch64 engine, overlayfs, root `/var/lib/docker`.
Initially no images, containers or volumes existed. Docker CLI was present but
`~/.orbstack/run/docker.sock` was missing. Starting the installed engine was enough
for Docker readiness; no reinstall/reset/context change was used.

The parent relayed explicit human approval for the independent official root
container worker, Docker socket/volume mounts and at most 5 GB download
(decision `604ad534-1654-4184-98db-b8ba9b92a948`). This was not host sudo approval.
All runtime settings, fixtures and Store were private test resources. The worker
published only on Mac loopback. Existing Docker context remained `orbstack`.

Direct registry CLI manifest requests timed out. Process-local HTTP(S)_PROXY used
the already configured system HTTP proxy `127.0.0.1:7890`, with TLS verification
unchanged. No system/OrbStack/daemon proxy settings were edited. Initial daemon
pulls made partial progress and were confirmed cancelled before the transfer
fallback. No completed archive was restarted.

The pinned download tool could not run because checkout
`desktop/aria2/aria2c` was absent. The parent explicitly authorized a test-local
fallback: official google/go-containerregistry v0.20.3 Darwin arm64 archive,
`gh release download`, checksum manifest verification, no system installation.
Crane transferred pinned images through the existing proxy; `docker load`
imported them. This took about two hours; slow transfer is not an E2E result.

Known complete payloads: Rust layers 597,728,932 bytes, Node layers 402,919,975,
crane archive 14,609,147, Cargo crate cache 32,059,505 bytes: about **1.05 GB**.
Git transfers and cancelled daemon partials add to this; complete wire-byte and
retry accounting was not captured. Content-based estimate including those is
below 3 GB, not an exact measured traffic total. No additional large images or
system toolchain downloads were requested; no evidence of exceeding 5 GB.
Disk expansion is separate: images 4.027 GB, Docker volumes 623.1 MB, test
filesystem about 1.2 GiB at inventory.

## Pins and artifact identities

- Repository: <https://github.com/Ephemeral-AI-Lab/layerfs>.
- Annotated tag v1.1.0: `80a973326887ed5c1d46a7dea0165b1529273c97`;
  dereferenced commit `9f97a7ec95b662e9cb288704afa165feff132cfa`.
- Actual tagged JS entry: `api/agent/sdk/src/index.js`, not main's flattened path.
- Rust 1.85.1 bookworm arm64 manifest:
  `sha256:538cf66970a7b785126d682758b4a86c3411fe7ab308e70f8ac62f46af153224`.
- Node 24.21.0 bookworm arm64 manifest:
  `sha256:481d53bf381928c9e3bb5cedf90687d81a78986cf4d7fe5a5fdfc8de1c5fe413`.
- Imported Docker image IDs: Rust
  `sha256:295172520ea987db796393550f0615db0dfb7d99240ea4b8efde1ff33192bd67`;
  Node `sha256:6866a2fb799e48fa876ae5201cacb693ccef033fc0de3c8bda0116d04694abca`.
  Docker 29's containerd image store reports imported manifest IDs, not the OCI
  config digest. Every archive config and compressed layer was independently
  SHA-256 compared with the pinned registry manifest before use. Imported tags
  `*:i-was-a-digest` are crane's import labels, not version pins.
- Crane archive SHA-256:
  `7a46898cf7ba8b995ae8eed3a6c29d7038058b409d92ead456ff12b47a9dde37`.
- Bundle: `build-linux-07e5a29823294469899e9fb4b87b0207`.
- Daemon SHA-256:
  `9ce8b91ca736d912dc55dbc114307cea1a937c5383b1100490686c4d349fad96`.
- Addon SHA-256:
  `f4311e7c8682e1e9223daab0d904a7f664496a32c72fb8170eeb26778d5b6266`.
- Bundle manifest SHA-256:
  `6e4e5cece7ac6e7cc4c6f3eb467d47428aecae513a747675547eb65584388b2a`.

Build used official worktree register/prepare/build commands, private Cargo and
build cache volumes, `cargo +1.85.1 build --manifest-path core/Cargo.toml --locked
--offline -p layerfs-daemon -p layerfs-node -j 6 --release`. Store is Disposable;
no Durable execution. Shadow HEAD at final inventory was
`d1427073e050ac1a645a37d226cea9b142a5cf5b`; this test did not commit that revision.

## Failure evidence and compatibility findings

Evidence root (retained; not a rerunnable passing harness):

`/Users/honx/Workspaces/shadow/.tmp/layerfs-mac-e2e-20261105-114155`

- `receipts.jsonl`: all actual tool/SDK results, including definite failures.
- `real.log`: initial setup, create/forks; first sandbox refused before Docker
  request because SDK deployment socket incorrectly named host-only Mac socket.
- `real-resume.log`: corrected socket, empty inventory, then first Connect refusal.
- `real-orb-host.log`: explicit host.orb.internal attempt, two mounts and real
  ordinary tools/commits/load, then restored new-sandbox Connect refusal.
- `finish.log`: clean agent-a status, retained Join failure.
- `finish2.log`: agent-b checkpoint, SDK existing-sandbox restored read and clean
  close, then agent-b retained Join failure. Its diagnostic PASS label is scoped
  to restored-byte recovery, **not overall test success**.
- `final-network-inventory.txt`, `final-inventory.txt`, `sandbox1-daemon.log`,
  `sandbox2-daemon.log`, build logs/manifests, registry manifests and archives.
- `real*.ts`, `finish*.ts` are staged once-only attempt/continuation scripts, not
  safe to rerun against retained Projects. No unknown mutation was auto-retried.

The runtime settings' `docker` must name the Mac socket to launch containers;
SDK deployment `LAYERFS_DOCKER` must name `/var/run/docker.sock` **inside worker**.
This was fixed only in test configuration after a definite no-request refusal
and empty inventory. Setting one host socket for both is invalid.

Actual Docker inspect showed sandbox ports `127.0.0.1:32771/32772 -> 30421`.
A separate same-image network probe published `127.0.0.1:32770 -> 31337`;
Mac localhost and worker `host.docker.internal` / `host.orb.internal` all read its
response, while gateway.docker.internal timed out. Thus basic host forwarding
works; an OrbStack publication/readiness race remains a **hypothesis**, not a
proven root cause. Failed sandbox receipts preserve daemon LISTEN lines and
`removed:true`; failed containers had already been removed by upstream and
could not be inspected afterward. No broad listener setting was changed.

Pinned source locations:
`core/crates/layerfs-api/src/sandbox/create.rs:49` selects first resolved address;
`:350–355` obtains endpoint then performs one immediate TCP connect after
`wait_listener`. `core/crates/layerfs-daemon/src/control/unmount.rs` and
`core/vendor/fuser-0.18.0/src/session/lifecycle.rs` belong to retained Join evidence.
The runtime platform is `api/runtime/src/platform/macos/index.js`; it defaults
worker daemonHost to host.docker.internal and mounts only the configured resources.

Windows' official fixed commit
`73d974dea8a8d0b056a16dc6b2380d89438ce484` adds Docker API negotiation, not a
Mac readiness/teardown fix. Mac API 1.56 already accepts tag's fixed 1.54.
`fixed-relevance.txt` proves identical Git blob IDs tag versus fixed:
create `2146783582ddd566585f352e60e56b33bd07923d`,
unmount `ca1d959a651ff1a955344c8b025d968d1091d12b`,
fuser lifecycle `24119306b2f36591628afc12506567938488412b`.
These files only relocated between the two pins compared. **Correction from the
restart investigation:** searching only those historical paths missed official
`35d36575c1eb4d23d4b54534a7030d855db890e7` (#500), which fixes stalled normal
unmount under the newer `engine/crates/` paths. The original decision to end this
run was based on that incomplete search; it is not evidence that no official
teardown fix exists. API negotiation alone is still unrelated to the two failures.

## Final resources and next steps

- OrbStack/Docker remain Running; existing context unchanged.
- All runtime clients closed. Official worker normal SIGTERM stop completed
  (Exited 143); no SIGKILL timeout was enabled. Endpoint file remains test-local,
  now stale; it is not copied into this report (contains a secret).
- Two sandbox containers remain Running with retained teardown custody. Their
  saved commits/Store/branches remain. No force close, remove, reset or deletion.
- Network probe remains Running: normal `docker stop --time -1` did not finish
  for its Node PID 1; waiting CLI was cancelled, no stronger signal was sent.
  Its server is loopback-published, credential-free, unrelated to LayerFS data.
  Do not mistake cancellation of that CLI for confirmed container shutdown.
- Read-only cache-inventory container remains Exited 0.
- Volumes: `lfs-mac-114155-store`,
  `lfs-dev-upstream-73e5750e8d80-cargo`, `lfs-dev-upstream-73e5750e8d80-target`.
- Source, sealed bundle, archives, caches and evidence retained. No transfer or
  native build process remains active. No production SHADOW_LAYERFS_CONFIG set.

Original follow-up requirement: a source-backed OrbStack transport solution and
investigation of FUSE Join custody were needed before stable Mac qualification.
The [restart retest](layerfs-e2e-macos-restart-20261105.md) now records the official
#500 teardown fix plus an explicit patched-upstream bridge route and bounded
passing results. It does not activate production or repair the retained resources.
Do not add unproven sleeps/retries or widen loopback publication. Supporting an
explicit existing sandbox in Shadow's mount API could avoid unnecessary Create,
but is a proposed integration change, not a fix delivered here, and would not
resolve retained Join failures. Revalidate on one fresh isolated Project after
an actual relevant upstream fix, preserving these failed resources until their
custody/cleanup policy is explicitly resolved.
