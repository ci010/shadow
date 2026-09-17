> **WIP design/workstream reference.**
> Main/Child composition exists, but role contracts do not prove end-to-end
> distributed readiness. Deno-era startup/packaging references below are
> historical; current runtime development uses direct Node.js/pnpm. See the
> [status/index](README.md) and [current architecture](../architecture.md).

# S4: Runtime Roles and Headless Main

> **Implementation update:** descriptive service catalogs and empty Child
> capability-registry/artifact-staging lifecycle slots have been removed.
> The real loopback control service is optional; it is not a remote API proxy.
> Execution approvals below are also retired. The role list remains design
> history, not evidence that all those services are implemented.

> Owner: runtime platform
>
> Depends on: S0, S1

## Goal

Split the current monolithic startup into explicit composition roots without
duplicating business logic. Main must run with no Electron or desktop session;
Child must not initialize brain-only services.

## Owned Modules

- `src/index.ts`
- `src/config/schema.ts`
- new runtime composition modules
- headless CLI commands
- lifecycle/readiness/shutdown wiring

S3 owns cluster internals. S5 owns Electron lifecycle. S8 owns installers and
container/service manifests.

## Composition Roots

```ts
startMainRuntime(config): MainRuntimeHandle
startChildRuntime(config): ChildRuntimeHandle
```

Main includes:

- providers and LLM runtime;
- sessions, memory, wiki/knowledge, skills, agent definitions;
- channels, cron, events, VFS, durable stores;
- cluster listener and node registry;
- optional local executor capability.

Child includes:

- Main connector and local remote-API proxy;
- node identity and capability registry;
- local executors and approval service;
- temporary artifact staging;
- no providers, sessions database, memory/wiki store, channels, or cron.

## Bootstrap Configuration

Separate installation bootstrap from mutable Main agent config.

```ts
interface BootstrapConfigV1 {
  version: 1
  mode: 'main' | 'child'
  dataDir: string
  localNodeId: string
  mainEndpoint?: string
}
```

Secrets and private keys are references to protected storage, not plain values in
renderer-readable config.

## Headless CLI

Provide non-GUI commands for:

- initialize data and identity;
- validate configuration;
- start server foreground/service mode;
- print health/status without secrets;
- create/revoke pairing offers;
- list/approve/revoke nodes;
- rotate/recover admin credentials;
- graceful backup/export hooks.

Commands must have non-interactive modes suitable for containers, but secret input
must not be accepted as a normal command-line argument.

## Lifecycle

- Readiness means stores are migrated, listeners are bound, and required services
  can accept work.
- Liveness does not depend on model-provider availability.
- Shutdown stops accepting jobs, cancels or drains according to policy, flushes
  stores/audit, closes channels, and exits within a configured deadline.
- A Child sidecar reconnects with bounded exponential backoff and remains locally
  manageable while Main is offline.
- Desktop-hosted Child local control binds only to loopback and requires the
  per-launch bearer for readiness, shutdown, and approval administration.

## Tests

1. Import/start Main in an environment with no display variables or Electron.
2. Child startup never constructs provider/session/wiki/channel services.
3. Main brain-only startup does not register an implicit shell/workdir.
4. Desktop-hosted Main can opt into a local node using the same executor contract.
5. Config validation rejects role-incompatible fields with actionable messages.
6. SIGINT/SIGTERM and service stop perform graceful shutdown.
7. Readiness waits for migration and listener startup.
8. CLI pairing approval works with no connected UI.

## Exit Criteria

- Main and Child have independent process-level integration tests.
- `src/index.ts` is a thin argument/config dispatcher, not the owner of all runtime
  construction details.
