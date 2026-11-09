# Mac restart retest: upstream close fix + opt-in bridge transport

2026-11-05, Mac Main / OrbStack 2.2.5, Docker 29.8.2/API 1.56, Linux arm64.

## Verdict

**Patched upstream passed bounded real E2E; production Shadow remains disabled.**
No Shadow adapter source change was needed. Official `35d36575` alone still failed
one of two fresh sandbox connections. Do not call the official unpatched build,
all macOS deployments, or the currently running Shadow tool ready.

Final artifact: three fresh Projects (runs 6, 7, 8), each with three **new**
sandboxes, all passed init/fork/mount, ordinary Shadow read/write/exec, parallel
branch isolation, checkpoint/history, load to a new branch and its new-sandbox
mount, dirty-close refusal, and all three clean closes. A fourth fresh Project
ran the delivered generalized harness and passed the same sequence. Thus final
artifact acceptance is **4 Projects, 12 new sandbox mounts, 12 clean closes, zero
failed mounts/closes**. No existing-sandbox placement substituted for Create.
Each Project's source stayed `baseline\n`; restored bytes were `agent-a\n` after
advancing the live branch to `newer\n`. Dirty returned `Dirty`, not success.

An earlier bridge patch without the final additional HostConfig checks passed
three other Projects / nine mounts / nine closes. These are supplementary, not
counted in the final 4/12/12 result. All close calls used force=false,
discard=false. No sleeps, automatic retry, repeated unknown mutation, repeated
old close, force-unmount, resource deletion or service reset was used.

## What was actually fixed

### Clean unmount: official #500, not the API negotiation change

The previous report's assertion that no relevant later official fix was found
was a **historical path-search omission**. Rust moved to `engine/crates/`.
Official commit `35d36575c1eb4d23d4b54534a7030d855db890e7` merges #500
(stalled detached normal unmount, with corrected abort custody); its merge
message identifies corrective commit `69fedcacf0` and original change
`888ae70cd988934798e820799bad6b25a3073bd8`.

Read `engine/crates/layerfs-daemon/src/control/detach.rs`,
`engine/crates/layerfs-fuse/src/session/force.rs`, and
`core/docs/issues/496/ABORT-CUSTODY-FIX-20261029.md` at that pin. After one
successful plain detach, a Join-stalled connection can outlive its mount because
an external engine/VM process has copied the mount namespace. The official fix
makes one connection abort write, drains again, and preserves exact failed/short
abort custody. This is **upstream's normal clean-close implementation**, not
Shadow issuing force=true or a test manually forcing cleanup. The precise
external OrbStack process holding the old connections was not identified.

On the unmodified official build, the sole successfully mounted fresh workspace
returned clean `Unmounted` in a separate once-only continuation. The final patch
does not change daemon/FUSE teardown code; twelve further clean closes verified
that official implementation repeatedly. None of the old retained workspaces
was retried or adopted.

### New sandbox transport: explicit local third-party patch

Even with the official close fix, fresh Project run 2 mounted sandbox 1, then
sandbox 2 failed at Connect with ECONNREFUSED after LISTEN, `removed:true`.
The ordinary worker -> `host.docker.internal` -> Mac published-port path remains
unreliable here. LISTEN is after TcpListener::bind in the daemon, not merely a
pre-bind announcement. The precise OrbStack forwarding defect/race is **not
proven**. Renaming that host, sleeping or replaying Create is not a fix.

The delivered patch adds explicit `LAYERFS_DAEMON_HOST=docker-bridge` for a Linux
worker on the same Engine's default bridge. It obtains the daemon endpoint from
the **same exact managed-container inspection**, avoiding the Mac host-forwarding
hop. It is not a caller-supplied IP and not fallback after a failed dial.

Fail-closed checks retain container ID, Project/sandbox labels, immutable image,
security topology, Store volume, running state and single 127.0.0.1 published
endpoint checks. Direct mode additionally requires HostConfig NetworkMode=bridge,
a single ephemeral 127.0.0.1 PortBinding for the expected daemon port, exactly one
Networks entry named bridge, and one nonempty private IPv4 address. It uses that
IP with the managed request's daemon port. Missing/multiple/foreign networks,
wrong labels, public/loopback/invalid IPs and widened publication are refused.
Noise expected-peer authentication and command permissions are unchanged.
The daemon already listens on the container interface; no listener or host
publication was widened. A worker not on that bridge will fail, not fall back.

## Deliverables and fixed identity

- Patch: `docs/layerfs-patches/35d36575-macos-docker-bridge.patch`
- Opt-in harness: `docs/layerfs-patches/macos-bridge-e2e.ts`
- Pins: `docs/layerfs-patches/macos-bridge-pins.json`
- Durable receipts: `docs/layerfs-patches/evidence/summary.json`,
  `final-project-{6,7,8}.jsonl`, `delivered-harness.jsonl`,
  `real-run2.log` (official transport failure), `official-close.log`,
  `rust-test-output.txt`, `final-artifact-manifest.json`.

Base commit: `35d36575c1eb4d23d4b54534a7030d855db890e7`.
Patch SHA-256: `7ea49cc5741ce7a1b68691936ca3ce81b1631e32b9508f393346098fdd7d6796`.
Sealed bundle: `build-linux-07e57fd0bb9e49788422ba378299ef9c`.
Manifest source identity: `d83be56f810adb16efb675d62b1599f93a518fc93f62c1cd9d6a957d08d9bcdb`.

SHA-256:

- daemon: `23fa35b31f1b614d6bbf60d7010acb4efd6e67473e6fd560f909abc8d2ea0490`
- addon: `01f40493b64c9cf22aa97563fd1322a92e3172585567dab6f6cc5d1a87264c1e`
- manifest: `96f70ad39b571436cb67ea70bc7e22f4039397fd187bec568f1470f7e02a24c4`

SDK is the matching bundle's `api/agent/src/index.js`, not the tag's sdk/src path.
Rust 1.85.1; build image
`sha256:295172520ea987db796393550f0615db0dfb7d99240ea4b8efde1ff33192bd67`;
runtime/sandbox image
`sha256:6866a2fb799e48fa876ae5201cacb693ccef033fc0de3c8bda0116d04694abca`.
These are the previously verified imported arm64 images, not new pulls.

## Reproduction

Prerequisites: authorized private root Linux worker, Docker socket and volume
mounts, pinned cached images, Linux Cargo dependencies, private resources record
and an untouched disposable Store volume per Project. This does not install or
activate anything in production. Do not reuse the recorded run directories or
volumes for another acceptance run.

Apply the delivered patch to a clean checkout at the base pin (`git apply --check`
then `git apply`). Register that checkout with upstream `tools/worktree.py
register` using the pinned image IDs above. The existing run copied **only private
Cargo/build cache volumes**, read-only at source, to newly labelled cache volumes;
no credentials, Store or old sandbox ownership was copied. New source layout
uses root Cargo.toml, not core/Cargo.toml. The exact build/test commands were:

```sh
python3 "$UPSTREAM/tools/worktree.py" build --resources "$RESOURCES" --platform linux --profile release --jobs 6
python3 "$UPSTREAM/tools/worktree.py" cargo --resources "$RESOURCES" --platform linux --timeout 100 -- test -p layerfs-sandbox --test container_labels
```

Build receipt's actual compiler argv: `cargo +1.85.1 build --manifest-path
Cargo.toml --locked --offline -p layerfs-daemon -p layerfs-node -j 6 --release`.
Four Rust tests passed, including ten direct-route accept/refuse table cases.
`git diff --check` and reverse-apply check of the delivered patch passed.
Rustfmt was NOT_RUN: pinned image has no cargo-fmt component; no new component
was installed. No claim of full upstream suite or performance qualification.

To execute the delivered harness from Shadow repository root, create a **fresh**
absolute evidence directory and its `setup.json` containing `bundle` (absolute
sealed bundle path), `nodeImage` (pinned runtime image above), and `socket`
(`/Users/honx/.orbstack/run/docker.sock` in this test). Choose a unique lowercase
alphanumeric/dash tag of at most 32 characters. Provision each volume first:

```sh
export LAYERFS_E2E_ROOT=/absolute/private/new-evidence-root
export LAYERFS_E2E_TAG=unique-qualification-tag
# setup.json must already exist at $LAYERFS_E2E_ROOT; no secrets in setup.json.
set -e
for i in 1 2 3; do
  docker volume create --label layerfs.test=qualification "lfs-mac-${LAYERFS_E2E_TAG}-${i}-store"
  node --import tsx docs/layerfs-patches/macos-bridge-e2e.ts "$i"
done
```

The harness refuses an existing run directory. It creates private fixtures,
process-local config and its own worker, then calls actual LayerFSTool,
ReadTool, WriteTool and ExecTool classes. It does not configure the currently
running Shadow service. Runtime.close closes the client; it does not stop the
worker. After inspection, explicitly stop only the workers created by that run
with normal SIGTERM (`docker stop --time -1 <exact-worker-name>`), never rm -f.
Sandbox lifecycle expiry is independent of Workspace clean-close receipts.

## Failures, remaining resources, and authorization

Two preliminary harness setup errors were definite pre-Init refusals:
`LAYERFS_STORE_POLICY=Disposable` was wrong (that key means deduplication tuning,
not SQLite persistence); and an unprovisioned volume directory was absent.
Both are retained in `.tmp/layerfs-mac-restart-20261105/{run1,real-run1}.log`.
No unknown mutation was retried. Actual native Project Init explicitly selects
Disposable in `engine/crates/layerfs-node/src/project.rs`; Durable NOT_RUN.
Official run 2's connection failure remains a failure, not erased by patched runs.

Full local build/test evidence and artifacts remain under
`/Users/honx/Workspaces/shadow/.tmp/layerfs-mac-restart-20261105/`.
Final bundle resides under `resources/upstream-e27abd337afe/artifacts/` there.
This is a retained test build, not a production installation. Durable source
patch, manifest and receipts are delivered under docs as listed above.

All ten newly created test workers were normally stopped, Exited 143; no SIGKILL.
New saved Stores/branches, exited containers and two private build-cache volumes
remain. At final inventory all 22 newly created successful sandboxes had naturally
expired, Exited 0; none was force-stopped or removed. The two **old** retained
sandboxes, old network probe and old Store/cache resources were untouched and
remain running. See `docs/layerfs-patches/evidence/final-inventory.txt` and local
`worker-stops.log` for exact resources.

Authorization used only the already approved independent root containers and
Docker socket/volume mounts. No host sudo/root, system component installation,
Docker/OrbStack reset, production worker startup, bot.config/.env edit, Shadow
restart, commit or push. Existing unrelated edits and Windows files were preserved.
No new image/toolchain/crate download: cached images and dependencies were reused.
Git source fetches (including two cancelled full-history transfers, then a shallow
pin fetch) add modest unmetered traffic; cumulative exact bytes remain unknown,
with no evidence of approaching the original 5 GB budget.

Production still has no SHADOW_LAYERFS_CONFIG. Activation requires an operator
installation of this **patched** matched bundle, authorized private worker/Store,
and an operator-owned Project configuration with
`LAYERFS_DAEMON_HOST: "docker-bridge"`. That environment key is **already allowed**
by Shadow, so no adapter allowlist change is necessary. It remains a string
setting unavailable as a model-selected IP/SDK path. Keep Mac host Docker socket
in runtime settings and `/var/run/docker.sock` inside the worker. No settings
were activated here. Crash recovery, large-workspace performance, external
engine namespace ownership and deployment beyond this default-bridge OrbStack
configuration remain unqualified.
