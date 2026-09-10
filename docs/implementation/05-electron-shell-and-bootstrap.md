> **WIP design/workstream reference.**
> Main-on-Electron bootstrap/supervision is implemented; Child/product setup and
> release validation remain separate work. Older compiled-sidecar or Deno
> packaging assumptions below do not describe the current Node backend module.
> See the [status/index](README.md), [current architecture](../architecture.md),
> and [current build commands](../../README.md).

# S5: Electron Shell and Bootstrap

> Owner: desktop platform
>
> Depends on: S0, S3, S4

## Goal

Package the existing Vue application as the renderer, implement the first-run
wizard, and supervise the correct local sidecar. Do not move brain logic into
Electron main or expose Node APIs to Vue.

## Owned Modules

- new `desktop/` Electron package
- Electron main and preload code
- bootstrap config and OS credential-store adapters
- sidecar process supervisor
- Child local proxy integration
- native folder picker and tray/approval integration

S6 owns Vue product screens. S8 owns final packaging/signing/update pipelines.

## Electron Security Baseline

- `contextIsolation: true`;
- `nodeIntegration: false`;
- renderer sandbox enabled;
- strict navigation/window-open policy;
- minimal typed preload API;
- random per-launch token for renderer-to-local-sidecar calls;
- device private keys remain outside renderer storage;
- CSP suitable for the packaged Vue/Monaco assets.

## Wizard State Machine

Wizard progress is resumable and stored outside Main data until completion.

**Host Main on this PC**

1. choose role;
2. choose data directory;
3. initialize Main identity/config;
4. configure provider authentication;
5. choose optional local-node capabilities;
6. launch Main sidecar and verify readiness;
7. enter normal UI.

**Join as Child Node**

1. choose role;
2. enter/scan Main endpoint and pairing offer;
3. verify fingerprint and wait for approval;
4. name device;
5. choose local folders/capabilities and approval policies;
6. launch Child sidecar/local proxy;
7. enter normal UI.

Role reconfiguration is a separate destructive flow with backup/archive and
credential revocation steps.

## Sidecar Supervisor

- Use explicit executable/resource paths; never depend on cwd.
- Capture bounded structured logs and expose diagnostics.
- Wait for authenticated readiness before showing the workspace.
- Distinguish configuration error, port conflict, migration failure, crash, and
  Main-unreachable states.
- Restart Child connector failures with backoff; do not blindly restart a crashing
  Main migration loop.
- Gracefully stop sidecars on quit and handle forced termination.

## Local Proxy

The renderer always uses a loopback `apiBase`. In Child mode, the sidecar proxies
only S3's remote API facade and merges local endpoints for connection, grants, and
approvals. Response/error shapes should remain compatible with the Vue client.

## Tests

1. Fresh install reaches each wizard role and resumes after interruption.
2. Renderer has no Node/global filesystem access.
3. Wrong fingerprint, expired pairing, pending approval, revocation, and Main
   offline each show a distinct recoverable state.
4. Native folder selection creates a Child capability without exposing arbitrary
   path access to renderer code.
5. Sidecar crash/restart and app quit leave no orphan process.
6. Desktop-hosted Main and Child packages locate all resources when launched from
   another cwd.
7. Playwright desktop screenshots cover wizard and offline states on supported
   viewport sizes.

## Exit Criteria

- Electron can host Main or join a headless Main with one packaged Vue build.
- No Electron-specific branch exists inside backend business logic.
