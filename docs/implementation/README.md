> **WIP workstream archive — read this first (September 2026).**
> This directory contains distributed-desktop specifications and historical
> integration checkpoints. Multi-device infrastructure is **not a completed
> product release**. The readiness wording, test counts, ownership locks, and
> Deno commands below belong to their recorded checkpoint; they are not a
> current verification result or current operating instructions. Node/pnpm has
> replaced the Deno toolchain without a Deno compatibility shim.
>
> Start with the [current architecture](../architecture.md), especially the
> [WIP device boundary](../architecture.md#multi-device-infrastructure--wip),
> [documentation index](../README.md), and [current commands](../../README.md).
> Original plans and progress reports are retained below for design context.

# Shadow Distributed Desktop Implementation

> Status: Wave 4 Main desktop vertical slice integrated
>
> Source design: `DESIGN-BRAINSTORM.md`

This directory turns the architecture brainstorm into agent-sized workstreams.
Each document owns a module boundary and lists the contracts it may consume or
change. Agents should not expand their scope into another stream merely because
a shared file is nearby.

## Readiness Status

**Architecture status:** Wave 1-3 foundations and the Main-on-Electron Wave 4
vertical slice are integrated. Main now owns durable pairing, approval,
challenge, and node WebSocket composition. The production Child uses protected
Ed25519 credentials and reconnect challenge proofs, advertises its shell, and
can bind Child-owned workdir capabilities for bounded UTF-8 reads and writes.
Child-authoritative approval queues and in-memory grants are available through
its authenticated loopback control API. Main now routes jobs through a
node/session-bound `RemoteExecutor`; remote session workdirs can list, read,
write, edit, and preview UTF-8 files without exposing Child physical paths.
Binary artifacts, remote search/process execution, live remote UI data, and the
Electron/Vue approval interface remain incomplete.

**Current test baseline:** `deno task test` passes with 0 failures. The
package-local Electron suite passes with 75 tests and 0 failures.
Electron typecheck/build and the Vue production build pass; the Vue build
retains the existing large-chunk warning.

### Live Progress

| Lane    | Status                 | Completed slice                                                                           | Validation                                    |
| ------- | ---------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------- |
| L1 / S1 | In progress            | SQLite persistence plus local/remote `WorkdirRef` capability resolution                   | Locality/store and route coverage             |
| L2 / S7 | In progress            | Loopback default, strict browser/Electron origin policy, explicit Docker host override    | 12 gateway tests                              |
| L3 / S6 | In progress            | Role/scope context plus fixture-backed Workspaces and Nodes views                         | 5 policy tests + app build                    |
| L4 / S8 | In progress            | Modern/legacy migration plus structured distributed job audit                             | 7 migration/audit tests                       |
| L5      | Existing work retained | Dynamic import/invoke tool changes remain owned as one lane                               | Included in full suite                        |
| S2      | In progress            | Remote executor, confined UTF-8 workdir tools, and Child-local approval/grants            | Execution, API, route, and transport coverage |
| S3      | In progress            | PIN API, Ed25519 challenge proof, authenticated WebSocket ownership, and Child connector  | 55 cluster tests + connector coverage         |
| S4      | In progress            | Main/Child lifecycles plus authenticated local readiness, approvals, and shutdown         | Lifecycle/control integration coverage        |
| S5      | In progress            | Resumable Main bootstrap, secure request authorization, recovery, and process supervision | 75 desktop tests + build                      |

The integrated Main desktop path now persists a restart-safe launch profile,
starts or resumes the sidecar before mounting the product UI, and returns only a
safe installation context to Vue. The launch bearer remains in Electron main and
is injected only for requests from the current main `webContents` to the exact
literal-loopback runtime origin. Packaged `file://` requests use the
authenticated opaque-origin CORS path; wildcard or arbitrary remote origins
remain rejected. Failed sidecar starts release their launch state so recovery
can create a fresh supervisor and credential.

Electron's Node-only tests use the `*.node-test.ts` suffix so root Deno test
discovery does not load Node ESM `.js` imports. The app-wide lint command still
reports four pre-existing findings in `monaco-loader.d.ts`, `media-url_test.ts`,
and `useTheme.ts`; the touched renderer bootstrap files are clean.

**Repository fan-out status:** checkpoint required before parallel coding. The
current worktree contains two coherent in-progress runtime groups:

- session state/preload changes in S1-owned files;
- dynamic tool import/invocation changes spanning S2 surfaces and the S4-owned
  `src/index.ts` hotspot.

Do not create parallel branches/worktrees from a commit that omits these changes
and do not let new agents independently reinterpret them. Before fan-out,
either:

1. finish and checkpoint each group as a coherent commit; or
2. explicitly assign each dirty group to one owner and keep every other stream
   out of those files until that owner checkpoints it.

The S0 decisions in `00-contracts-and-decisions.md` are frozen for Wave 1. Its
deferred cryptography, retention, and packaging choices block later S3/S8
release completion, not S1/S6/S7 startup.

## Maximum-Safe Initial Parallel Launch

After the worktree checkpoint, start these lanes concurrently:

| Lane | Scope                             | May edit now                                                       | Must not edit yet                |
| ---- | --------------------------------- | ------------------------------------------------------------------ | -------------------------------- |
| L1   | S1 persistence and local locality | S1-owned session/path modules                                      | executor/network/UI modules      |
| L2   | S7 gateway baseline               | gateway middleware/server; media changes only after S1 path review | cluster listener                 |
| L3   | S6 fixture-first UI               | Vue routes/layout/new views/mock contracts                         | production transport or Electron |
| L4   | S8 migration baseline             | legacy fixtures, migration audit/tests, release matrix             | final package wiring             |
| L5   | Existing dynamic-tool work        | its current tool files and tests                                   | S1 locality redesign             |

This is five productive lanes without violating dependency edges. L2 and L3
should use adapters/fixtures at boundaries rather than waiting for the whole
backend.

As soon as S1 publishes its resolver and persistence contract:

- start S2 local executor extraction;
- start S4 composition-root extraction in new modules;
- let S6 replace locality fixtures with S1 APIs.

As soon as S2 publishes the job envelope and executor conformance suite:

- start S3 pairing/transport against a fake executor;
- start S8 job/audit correlation;
- continue S4 wiring without waiting for Electron.

S5's runtime host now supervises the real process contract and uses S4's
authenticated local readiness/shutdown API. S4's Child lifecycle is wired to an
S3 concrete connector, while S3 keeps proof material behind Windows CurrentUser
DPAPI, WSL-to-Windows DPAPI, or Linux Secret Service. Main mounts bounded PIN,
admin approval, challenge, and node WebSocket routes, persists public keys and
proposed credential identifiers, restores verifiers after restart, and drains
node sessions before its final snapshot. `scripts/pair-child.ts` reads the PIN
from stdin and persists only a non-secret credential reference.

## Agent Launch Template

Every implementation agent should receive:

1. `DESIGN-BRAINSTORM.md` for product context.
2. `00-contracts-and-decisions.md` as the shared contract.
3. Exactly one S1-S8 workstream document as its ownership scope.
4. The current checkpoint commit and any explicitly inherited dirty files.
5. A prohibition on structural edits to another stream's locked files.
6. A requirement to run the stream's focused tests plus `deno task test` before
   handoff.
7. A handoff report listing changed contracts, migrations, feature flags, tests,
   and remaining integration assumptions.

The integration owner, not individual stream agents, resolves cross-stream
changes to `src/index.ts`, `src/config/schema.ts`, `src/channels/web.ts`, and
shared package configuration.

## Missing Decisions Found During Audit

The broad topology is coherent, but implementation should not begin until these
points are explicit:

1. Installation role and UI authorization are separate. A Child runtime may host
   an owner/admin UI for a headless Main.
2. Remote UI traffic and node execution traffic need separate authenticated
   protocols, even if they share one TLS port.
3. Remote locality covers filesystem, process, MCP, browser, and Windows tools.
   A remote shell alone is not enough.
4. `WorkdirRef` must persist an opaque capability ID, not treat a path on one
   node as globally meaningful.
5. Session data, node workdirs, transferred artifacts, and temporary Child
   staging need different retention and ownership rules.
6. Multiple connected UIs can mutate the same session/config. APIs need revision
   or idempotency semantics instead of last-write-wins by accident.
7. Protocol and package version skew must be detected before a job is accepted.
8. Main backup, recovery keys, device revocation, and first-admin recovery are
   part of the MVP operational boundary.
9. Existing JSONL/SQLite sessions need a tested migration and rollback path.
10. Headless Main needs health, readiness, logs, graceful shutdown, and CLI
    administration without Electron.

The initial answers and type-level contracts are in
`00-contracts-and-decisions.md`. A stream that needs to change one must update
that document first and notify every dependent stream.

## Workstreams

| ID | Document                                | Primary owner     | Depends on                     |
| -- | --------------------------------------- | ----------------- | ------------------------------ |
| S0 | `00-contracts-and-decisions.md`         | Architecture lead | None                           |
| S1 | `01-session-state-and-locality.md`      | Runtime core      | S0                             |
| S2 | `02-execution-and-artifacts.md`         | Runtime execution | S0, S1                         |
| S3 | `03-cluster-security-and-remote-api.md` | Network/security  | S0, S2 contract                |
| S4 | `04-runtime-roles-and-headless-main.md` | Runtime platform  | S0, S1                         |
| S5 | `05-electron-shell-and-bootstrap.md`    | Desktop platform  | S0, S3, S4                     |
| S6 | `06-frontend-product-ui.md`             | Frontend          | S0; mocks first, then S1/S3/S5 |
| S7 | `07-gateway-hardening.md`               | Security          | S0; mostly independent         |
| S8 | `08-release-migration-observability.md` | Release/SRE       | S1-S7 contracts                |

## Parallelization Waves

### Wave 0: contract freeze

- S0 records the first protocol/type versions and unresolved decisions.
- No runtime implementation branches merge until S0 is reviewed.

### Wave 1: correctness and security baseline

- S1 fixes session persistence parity and introduces local-only locality types.
- S7 hardens the existing loopback gateway in parallel.
- S6 may build role-aware route/layout shells against fixtures only.

### Wave 2: runtime separation

- S2 extracts local executors and artifact contracts without networking.
- S4 extracts Main and Child composition roots and headless commands.
- S6 implements workdir/node/permission components against stable S0/S1 types.

### Wave 3: network plane

- S3 implements pairing, device auth, remote UI API, node WebSocket, and
  registry.
- S2 adds the remote executor adapter against S3's transport interface.
- S8 adds job/audit correlation as soon as the job envelope is stable.

### Wave 4: desktop integration

- S5 adds Electron, setup wizard, local proxy, and sidecar lifecycle.
- S6 integrates real installation context, connection state, and approvals.
- S8 builds desktop and headless artifacts and the compatibility matrix.

### Wave 5: release hardening

- Run migration rehearsals, clean-machine packaging tests, network failure
  tests, and security checks.
- Do not add agent federation in this release.

## File Ownership Locks

These files are collision hotspots. During a wave, only the listed stream should
make structural changes to them:

| File                              | Owning stream                      |
| --------------------------------- | ---------------------------------- |
| `src/sessions/session-store.ts`   | S1                                 |
| `src/sessions/session-manager.ts` | S1 until Wave 2 completes          |
| `src/utils/paths.ts`              | S1                                 |
| `src/tools/shell.ts`              | S2                                 |
| `src/agent/process-manager.ts`    | S2                                 |
| `src/index.ts`                    | S4                                 |
| `src/config/schema.ts`            | S4; contract changes require S0    |
| `src/gateway/server.ts`           | S7                                 |
| `src/channels/web.ts`             | S7, with S1 review for media paths |
| `app/src/App.vue`                 | S6                                 |
| `app/src/router.ts`               | S6                                 |
| `app/src/components/ChatTab.vue`  | S6                                 |
| `deno.json`                       | S8 after S4 startup tasks land     |

S3 should prefer new modules under `src/cluster/` rather than adding cluster
behavior to `src/gateway/server.ts`. S5 should prefer a new `desktop/` package
and must not rewrite the Vue app inside Electron-specific code.

## Integration Rules

- Shared wire and persistence types live in dependency-light modules and have
  schema tests.
- Every protocol payload carries an explicit version.
- Every persisted schema change has forward migration, rollback notes, and mixed
  old/new data tests.
- Agents add contract tests before integrating two streams.
- A stream does not import Electron into backend modules or backend internals
  into the renderer.
- Main and Child must remain testable as separate processes.
- Use feature flags until local execution parity and migration are verified.

## Definition of MVP

The MVP is complete when:

1. Existing local sessions migrate without loss.
2. A headless Main starts with no desktop environment.
3. A Child pairs with Main and reconnects after restart.
4. An admin Child can operate Main without storing Main data locally.
5. A session selects a Child workdir and can read, edit, search, and execute
   there.
6. Child-local approval is required where policy says so.
7. Main stores the resulting session, wiki/knowledge, audit, and artifacts.
8. Offline/revoked/version-mismatched nodes fail explicitly and never fall back
   to another filesystem.
9. The Electron and headless packages pass clean-machine smoke tests.
