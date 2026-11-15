import { randomUUID } from 'node:crypto'
import type { Executor } from '../executor.ts'
import type { ExecutionContext } from '../../tools/context.ts'
import type { ExecutionReceiptV1 } from '../contracts.ts'
import { ToolNoEffectError, ToolOutcomeUnknownError } from '../../tools/tool.ts'
import { LAYERFS_REMOTE_OPERATION, layerFSPayloadHash, type RemoteLayerFSAction, type RemoteLayerFSAuthority, type RemoteLayerFSCall } from './remote-contract.ts'

export interface RemoteLayerFSTarget { nodeId: string; pairingId: string; projectScope: string }
/** Supplied by Main composition, never by tool arguments or a generic remote script. */
export type VerifyRemoteLayerFSOwner = (context: ExecutionContext, target: Readonly<RemoteLayerFSTarget>, action: RemoteLayerFSAction,
  input: Readonly<Record<string, unknown>>) => Promise<{ actorId: string; authorityKind: RemoteLayerFSAuthority['kind']; approval?: RemoteLayerFSAuthority['approval'] }>
export class RemoteLayerFSClient {
  constructor(private readonly target: RemoteLayerFSTarget, private readonly executor: Executor, private readonly verify: VerifyRemoteLayerFSOwner, private readonly onDispatch?: (requestId: string) => void, private readonly observe?: (text: string) => void) { this.target = Object.freeze({ ...target }) }
  async call(action: RemoteLayerFSAction, input: Record<string, unknown>, context: ExecutionContext): Promise<unknown> {
    if (context.recoveringToolCall) throw new ToolOutcomeUnknownError('Saved LayerFS mutation was not replayed; inspect target retained receipts.')
    const snapshot = structuredClone(input)
    const payloadHash = layerFSPayloadHash(action, snapshot)
    const owner = await this.verify(context, Object.freeze({ ...this.target }), action, structuredClone(snapshot))
    context.signal.throwIfAborted()
    const now = Date.now(), id = randomUUID()
    const args: RemoteLayerFSCall = { version: 1, action, input: snapshot, authority: {
      version: 1, ...this.target, actorId: owner.actorId, kind: owner.authorityKind, ownerSessionId: context.sessionId, requestId: id,
      action, payloadHash, expiresAt: new Date(now + 60000).toISOString(), ...(owner.approval ? { approval: owner.approval } : {}),
    } }
    const request = { version: 2 as const, jobId: id, idempotencyKey: id, sessionId: context.sessionId,
      turnId: context.messageId ?? id, nodeId: this.target.nodeId, operation: LAYERFS_REMOTE_OPERATION, args,
      createdAt: new Date(now).toISOString(), deadlineAt: new Date(now + 330000).toISOString() }
    await this.executor.assertCanExecute?.(request, context.signal)
    this.onDispatch?.(id) // host persists any long-lived lifecycle guard before transport
    let output = '', bytes = 0
    let receipt: ExecutionReceiptV1 | undefined
    try {
      for await (const event of this.executor.execute(request, context.signal)) {
        if (event.jobId !== id) throw new Error('Uncorrelated LayerFS job event')
        if (event.type === 'stderr' && action === 'exec') this.observe?.(event.chunk)
        if (event.type === 'stdout') {
          bytes += Buffer.byteLength(event.chunk)
          if (bytes > 2097152) throw new Error('LayerFS response exceeds 2 MiB')
          output += event.chunk
        }
        if ('receipt' in event) receipt = event.receipt
      }
    } catch (error) {
      throw new ToolOutcomeUnknownError(`Remote LayerFS outcome unknown; target ${this.target.nodeId}, request ${id}. Inspect retained target receipt; do not replay. ${error instanceof Error ? error.message : String(error)}`)
    }
    if (receipt?.nodeId !== this.target.nodeId || receipt.jobId !== id) throw new ToolOutcomeUnknownError(`Remote LayerFS receipt missing; request ${id}. Do not replay.`)
    if (receipt.state === 'rejected') throw new ToolNoEffectError(`Remote LayerFS admission refused: ${receipt.reason?.message ?? 'target rejected request'}`)
    if (receipt.state !== 'completed') throw new ToolOutcomeUnknownError(`Remote LayerFS request ${id} is not confirmed complete; inspect retained target receipt. Do not replay. ${receipt.reason?.message?.slice(0, 1200) ?? ''}`)
    try { return JSON.parse(output) } catch { throw new ToolOutcomeUnknownError(`Remote LayerFS response invalid; request ${id}. Do not replay.`) }
  }
}
