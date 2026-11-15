import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ExecutionContext } from '../../tools/context.ts'
import type { ExecutionRequestV2 } from '../contracts.ts'
import type { LocalJobOperationHandler } from '../local-executor.ts'
import { ToolNoEffectError, ToolOutcomeUnknownError } from '../../tools/tool.ts'
import { hasLayerFSHostAuthority, withLayerFSHostAuthority } from './host-authority.ts'
import { LAYERFS_REMOTE_OPERATION, remoteLayerFSReadActions, validateRemoteLayerFSCall, type RemoteLayerFSCall } from './remote-contract.ts'

const receiptSchema = z.object({ version: z.literal(1), requestId: z.string().uuid(), payloadHash: z.string(), actorId: z.string(),
  phase: z.enum(['dispatched', 'completed', 'unknown']), result: z.unknown().optional() }).strict()
/** Target-owned durable admission; transport reconnection never means mutation replay. */
export class RemoteLayerFSService implements LocalJobOperationHandler {
  constructor(private readonly options: {
    nodeId: string; pairingId: string; directory: string
    /** This callback is the paired-host trust boundary. It must not read model booleans. */
    authorize: (request: ExecutionRequestV2, call: RemoteLayerFSCall, signal: AbortSignal) => Promise<void>
    dispatch: (call: RemoteLayerFSCall, context: ExecutionContext) => Promise<unknown>
  }) {}
  handles(operation: string): boolean { return operation === LAYERFS_REMOTE_OPERATION }
  async admit(request: ExecutionRequestV2, signal: AbortSignal): Promise<RemoteLayerFSCall> {
    if (!this.handles(request.operation) || request.workdirId !== undefined || !request.projectScope) throw new ToolNoEffectError('LayerFS requires the exact target node service and host Project scope')
    const call = validateRemoteLayerFSCall(request.args, { ...this.options, projectScope: request.projectScope })
    if (request.nodeId !== this.options.nodeId) throw new ToolNoEffectError('LayerFS target mismatch')
    await this.options.authorize(structuredClone(request), structuredClone(call), signal)
    signal.throwIfAborted()
    return call
  }
  async execute(request: ExecutionRequestV2, signal: AbortSignal): Promise<string> {
    const call = await this.admit(request, signal)
    const a = call.authority
    const root = join(this.options.directory, a.projectScope)
    const record = join(root, a.requestId)
    const file = join(record, 'receipt.json')
    const load = async (path = file) => receiptSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    const save = async (value: z.infer<typeof receiptSchema>) => {
      const temporary = file + '.' + randomUUID()
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
      await rename(temporary, file)
    }
    if (call.action === 'reconcile') {
      const input = z.object({ requestId: z.string().uuid() }).strict().parse(call.input)
      let prior
      try { prior = await load(join(root, input.requestId, 'receipt.json')) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return JSON.stringify({ phase: 'unknown', requestId: input.requestId })
        throw error
      }
      if (prior.actorId !== a.actorId) throw new ToolNoEffectError('LayerFS receipt belongs to a different actor')
      return JSON.stringify(prior)
    }
    const mutate = !remoteLayerFSReadActions.has(call.action)
    if (mutate) {
      await mkdir(root, { recursive: true, mode: 0o700 })
      try { await mkdir(record, { mode: 0o700 }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        let prior
        try { prior = await load() } catch { throw new ToolOutcomeUnknownError('LayerFS admission retained without a receipt; inspect target, do not replay') }
        if (prior.payloadHash !== a.payloadHash || prior.actorId !== a.actorId) throw new ToolNoEffectError('LayerFS request ID already bound to another payload/actor')
        if (prior.phase === 'completed') return JSON.stringify(prior.result)
        throw new ToolOutcomeUnknownError('LayerFS mutation already admitted; inspect target receipt, do not replay')
      }
      await save({ version: 1, requestId: a.requestId, payloadHash: a.payloadHash, actorId: a.actorId, phase: 'dispatched' })
    }
    try {
      const result = await withLayerFSHostAuthority(call, { ...this.options, projectScope: a.projectScope }, signal, async (context, admitted) => {
        if (!hasLayerFSHostAuthority(context, admitted.action)) throw new ToolNoEffectError('LayerFS action authority expired')
        return await this.options.dispatch(admitted, context)
      })
      if (mutate) await save({ version: 1, requestId: a.requestId, payloadHash: a.payloadHash, actorId: a.actorId, phase: 'completed', result })
      return JSON.stringify(result)
    } catch (error) {
      if (mutate) {
        await save({ version: 1, requestId: a.requestId, payloadHash: a.payloadHash, actorId: a.actorId, phase: 'unknown' })
        throw new ToolOutcomeUnknownError(`LayerFS mutation outcome retained as unknown (${a.requestId}); do not replay. ${error instanceof Error ? error.message : String(error)}`)
      }
      throw error
    }
  }
}
