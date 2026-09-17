> **WIP design/workstream reference, not product readiness evidence.**
> Contracts and decisions below belong to the distributed-desktop workstream;
> implementation status must be checked in source. Historical Deno commands and
> packaging assumptions are not current instructions. See the
> [status/index](README.md) and [current architecture](../architecture.md).

# S0: Contracts and Decisions

> **Retired execution-approval design:** approval policies and per-job approval
> fields below are historical, not current contracts. Paired nodes now execute
> supported operations directly; device pairing and capability ownership checks
> remain. See the [current architecture](../architecture.md).

> Owner: architecture lead
>
> Blocks: every implementation stream

This document is the contract registry. Types are illustrative until converted to
runtime-validated schemas. JSON wire data must not rely on TypeScript types alone.

## Decisions Frozen for MVP

### D1: one authoritative Main

One Main owns agent identity, LLM calls, sessions, memory, wiki, channels, cron,
node registry, and durable audit data. There is no automatic Main failover and no
shared writable session database.

### D2: two desktop setup choices

Electron offers `main` and `child`. The same Main runtime is separately packaged
for headless service/container deployment. Main's local executor is optional.

### D3: runtime role is not UI authorization

A Child device can have owner/admin UI scopes for a headless Main. Main data is
read and mutated remotely but remains stored on Main. Local Child capability grants
and approvals remain controlled by Child.

### D4: Child dials Main

Main owns the reachable TLS endpoint. Child initiates and maintains connections.
Main never requires an inbound listener on Child.

### D5: one external port, separate logical protocols

An implementation may multiplex these on one TLS listener, but authentication and
route policy remain separate:

- pairing bootstrap;
- authenticated remote UI REST/SSE;
- authenticated node-control WebSocket.

The existing local gateway is not exposed by changing its bind address.

### D6: capability-bound locality

A persisted workdir references a node and opaque capability. Main does not treat a
Child's absolute path as authority.

```ts
type NodeId = string
type CapabilityId = string

interface WorkdirRefV1 {
  version: 1
  nodeId: NodeId
  capabilityId: CapabilityId
  displayName?: string
  displayPathSnapshot?: string
}
```

The display path is informational. Child resolves `capabilityId` to its current
local root and enforces containment.

### D7: delivery and execution semantics

Transport may redeliver. Jobs are deduplicated by `jobId`; a reconnect must not
rerun an already accepted process. Cancellation is best effort and has a terminal
receipt. The MVP does not resume a running process on another node.

### D8: protocol compatibility

Every connection negotiates a protocol version and feature set. Major mismatch
rejects the connection. Minor capabilities are additive and explicitly advertised.

## Core Types

```ts
type InstallationMode = 'main' | 'child'

type UiScope =
  | 'chat:read'
  | 'chat:write'
  | 'knowledge:read'
  | 'main:admin'
  | 'nodes:admin'
  | 'audit:read'

interface InstallationContextV1 {
  version: 1
  mode: InstallationMode
  localNodeId: NodeId
  mainConnection: 'connected' | 'connecting' | 'offline' | 'unpaired'
  uiScopes: UiScope[]
  apiBase: string
}
```

```ts
interface CapabilityDescriptorV1 {
  version: 1
  capabilityId: CapabilityId
  nodeId: NodeId
  kind: 'workdir' | 'shell' | 'browser' | 'windows-ui' | 'gpu'
  displayName: string
  permissions: string[]
  approvalPolicy: 'always' | 'session' | 'grant'
  online: boolean
}
```

```ts
interface VersionHelloV1 {
  protocolMajor: 1
  protocolMinor: number
  implementationVersion: string
  features: string[]
}
```

## Identity and Authorization

- `agentId` identifies the brain/personality.
- `mainId` identifies the authoritative Main installation.
- `nodeId` identifies an execution device.
- A device credential authenticates a physical installation.
- UI scopes authorize operations against Main.
- Capability grants authorize Main requests against Child resources.
- Session ownership and user identity remain application concepts and must not be
  inferred from `nodeId`.

## API Concurrency

Configuration and mutable session metadata APIs should carry a revision or ETag.
A stale update returns conflict instead of silently overwriting a newer update from
another UI. Message submission carries a client-generated idempotency key.

## Artifact Ownership

- Main owns durable artifact metadata and retained copies.
- Child owns temporary staging and may evict it after acknowledged upload/expiry.
- Artifacts have content hash, media type, size, producer node, session/job IDs,
  retention class, and transfer status.
- File references are not raw `file://` or arbitrary absolute paths.

## Deferred Decisions

These require a focused security or product review but do not block S1 local work:

- exact device-key and certificate formats;
- maximum artifact size and retention defaults;
- whether remote admin endpoints use REST/SSE or a request tunnel over WebSocket;
- per-operation default approval policies;
- initial supported server operating systems and installer formats.

S3 and S8 must resolve these before network/release code is declared complete.

## Contract Acceptance

- Runtime validation schemas exist for all persisted and wire types.
- Fixtures cover valid, unknown-field, malformed, and unsupported-version data.
- No schema imports Electron, Vue, Hono, session manager, or process manager code.
- Each dependent stream references a schema version rather than copying an ad hoc
  interface.
