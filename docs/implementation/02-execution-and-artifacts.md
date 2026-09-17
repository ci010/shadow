> **WIP design/workstream reference, not product readiness evidence.**
> Executors and bounded remote UTF-8 filesystem paths exist; full remote tool
> parity and binary artifact/staging workflows remain incomplete. Historical
> runtime commands are not current instructions. See the
> [status/index](README.md) and [current architecture](../architecture.md).

# S2: Execution and Artifacts

> **Retired execution-approval design:** the approval fields, waiting state,
> grants, and local approval service described below have been removed.
> Cancellation, deadlines, capability/workdir validation, and device pairing
> remain. See the [current architecture](../architecture.md).

> Owner: runtime execution
>
> Depends on: S0, S1
>
> Blocks: S3 full node plane

## Goal

Extract machine-local operations behind contracts that work identically through a
local adapter or remote Child. Do not start with networking; prove local parity
first.

## Owned Modules

- `src/tools/shell.ts`
- `src/agent/process-manager.ts`
- new `src/execution/` modules
- filesystem/read/search tool adapters as needed
- `src/tools/load-tool.ts` and `src/mcp/client.ts` locality integration

S1 owns path semantics. S3 owns transport and pairing. S2 owns operation schemas,
execution lifecycle, output bounds, and artifact production.

## Critical Scope

Remote workdir support requires more than shell dispatch. The first executor
contract must cover the operations used by project workflows:

- filesystem stat/list/read/write/mkdir/remove;
- glob and text search;
- process start/output/status/cancel;
- artifact stage/fetch/acknowledge;
- MCP stdio startup in the selected workdir.

Browser, Windows UI, and GPU operations can be later capability families, but the
envelope and approval model must allow them.

The first production workdir slice now binds opaque capability IDs to absolute
roots in Child-owned bootstrap configuration. `filesystem.read` and
`filesystem.write` reuse the versioned job envelope, enforce bounded UTF-8
payloads, and verify lexical plus physical containment before access. Main does
not receive the physical root. Stat/list/search, richer writes, artifacts, and
the local approval UI remain follow-up work.

## Job Contract

```ts
interface JobRequestV1 {
  version: 1
  jobId: string
  idempotencyKey: string
  sessionId: string
  turnId: string
  nodeId: string
  capabilityId: string
  operation: string
  args: unknown
  createdAt: string
  deadlineAt: string
  approval: 'none' | 'local-required'
}
```

Job events are ordered per job and include sequence numbers:

- accepted;
- awaiting-approval;
- started;
- stdout/stderr chunk;
- artifact-ready;
- cancel-acknowledged;
- completed/failed/rejected/expired.

Terminal events contain a structured reason and execution receipt. Replayed
`jobId` returns the known state or receipt and does not spawn again.

## Executor Boundary

```ts
interface Executor {
  execute(request: JobRequestV1, signal: AbortSignal): AsyncIterable<JobEventV1>
  getStatus(jobId: string): Promise<JobStatusV1 | null>
  cancel(jobId: string): Promise<CancelReceiptV1>
}
```

Implement `LocalExecutor` first. `RemoteExecutor` is an adapter over S3 and must not
change tool-visible behavior.

## Artifact Contract

Large/binary output must not travel inside arbitrary tool-result strings.

- Stage bytes on the producing node.
- Compute content hash and metadata.
- Stream or upload with explicit size limits and backpressure.
- Main acknowledges durable receipt before Child evicts staging.
- Tool results contain artifact IDs and safe preview metadata.
- Interrupted transfers can restart by hash/chunk without rerunning the job.

## Approval Boundary

Child evaluates local policy before execution. Main may mark that it already has a
session grant, but Child remains authoritative. The approval request contains a
human-readable summary produced from structured operation args, not untrusted
preformatted HTML.

The in-memory Child approval service now enforces `always`, `session`, and
`grant` policy scopes per capability and operation. It emits bounded summaries,
never includes filesystem write content, clears grants on restart, and supports
deny, revoke, cancellation, and deadline expiry. A bearer-protected loopback API
lists pending requests and grants and accepts strict approve/deny/revoke bodies.

## Tests

1. Existing local shell behavior passes through `LocalExecutor` unchanged.
2. Filesystem operations cannot escape the granted root through `..`, symlinks,
   junctions, case differences, or absolute paths.
3. Duplicate job delivery starts one process.
4. Cancellation, timeout, expiry, and process exit each produce one terminal
   receipt.
5. Output truncation preserves a downloadable artifact when policy permits.
6. Transfer interruption resumes without duplicate artifact records.
7. MCP starts in the selected workdir and receives the expected environment.
8. Local and fake-remote adapters pass the same conformance suite.

## Exit Criteria

- Tools depend on executor/locality contracts rather than direct global process
  state for covered operations.
- S3 can serialize job requests/events without importing tool implementations.
