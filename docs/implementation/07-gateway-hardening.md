> **WIP design/workstream reference, not a deployment security guarantee.**
> Consult source for the actual loopback/origin/launch-credential behavior;
> acceptance criteria below do not imply a completed public-service boundary.
> See the [status/index](README.md) and [current architecture](../architecture.md).

# S7: Gateway Hardening

> Owner: security
>
> Depends on: S0
>
> Can run in parallel with: S1

## Goal

Make the existing local gateway safe as an Electron/backend boundary. This stream
does not implement the external cluster listener.

## Owned Modules

- `src/gateway/server.ts`
- local gateway authentication/origin middleware
- `src/channels/web.ts` media and upload routes
- gateway-facing config/session route policy

Coordinate media/session path semantics with S1. Coordinate startup options with
S4. S3 owns all externally reachable cluster routes.

## Required Changes

### Local bind and launch authentication

- Production desktop default is `127.0.0.1`, not `0.0.0.0`.
- Use an OS-assigned/random local port where practical.
- Require a random per-launch credential supplied by Electron/sidecar startup.
- Never write the launch credential to normal logs or renderer-persistent storage.

Headless internal admin endpoints follow explicit config and are not implicitly
opened by the cluster listener.

### Origin and browser policy

- Remove wildcard CORS in production.
- Allow only the packaged/local renderer origin and required development origins.
- Add strict response headers and CSP coordination with S5.
- Reject credentialed cross-origin requests by default.

### File and media containment

- Replace the broad media route that currently permits paths under the workspace
  parent.
- Serve only session artifacts or capability-mediated workdir files.
- Validate traversal, symlinks/junctions, case normalization, and MIME handling.
- Use opaque artifact/file IDs where possible rather than arbitrary absolute paths.

### Administrative API policy

- Config, auth, diagnostics, session deletion, and file routes require explicit
  local/remote scopes.
- Do not assume loopback alone is authentication.
- Add request size and rate limits for expensive routes.

## Tests

1. Production listener binds only loopback by default.
2. Missing/incorrect launch credential is rejected.
3. Unapproved Origin and preflight are rejected.
4. Dev mode explicitly permits configured Vite origin without broad wildcard.
5. Path traversal, sibling directory, symlink, junction, and prefix-confusion tests
   cannot escape the intended root.
6. Config/session destructive routes reject insufficient scopes.
7. Logs and errors do not echo credentials or sensitive absolute paths.

## Exit Criteria

- Security tests pass before Electron loads privileged product routes.
- No code path reuses the local gateway as the unauthenticated cluster server.
