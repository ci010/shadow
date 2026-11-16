import { resolve } from 'node:path'
import { RemoteLayerFSClient, type RemoteLayerFSTarget, type VerifyRemoteLayerFSOwner } from './remote-client.ts'
import { type RemoteLayerFSAction, type RemoteLayerFSLocation, remoteLayerFSActions, remoteLayerFSReceiptSchema } from './remote-contract.ts'
import type { ExecutionContext } from '../../tools/context.ts'
import type { Tool, ToolResult } from '../../tools/tool.ts'
import type { FolderRecord, LayerFSFolderRecord } from '../../folders/contracts.ts'
import { selectFolder } from '../../folders/identifier.ts'
import { ToolNoEffectError, ToolOutcomeUnknownError, completedToolFailure } from '../../tools/tool.ts'
import type { Executor } from '../executor.ts'
import { z } from 'zod'
import type { RemoteLayerFSJobReservations } from './remote-jobs.ts'
import type { RemoteLayerFSConsentPlans } from './remote-consent.ts'
const targetBootstrapResult = z.object({ ok: z.literal(true), result: z.object({ targetJobId: z.string().regex(/^layerfs-target:[a-f0-9-]{36}$/), targetNodeId: z.string() }).passthrough() }).passthrough()

export type { RemoteLayerFSLocation } from './remote-contract.ts'
/** Main holds registration/authority; target holds all LayerFS state and execution. */
export class RemoteLayerFSGateway {
  private closed = false
  private revocation?: Promise<void>
  private contextTargets = new Map<string, RemoteLayerFSTarget>()
  constructor(private readonly options: {
    projectId: string; folders: () => FolderRecord[]; executor: Executor; localExecutionAllowed?: boolean
    target: (nodeId: string) => RemoteLayerFSTarget
    verify: VerifyRemoteLayerFSOwner
    jobs?: RemoteLayerFSJobReservations
    consent?: RemoteLayerFSConsentPlans
    settleRequest?: (requestId: string) => void
    acquireAccess?: () => () => void
    revokeContexts?: (targets: RemoteLayerFSTarget[]) => Promise<void>
    register: (mount: string, location: RemoteLayerFSLocation, context: ExecutionContext, description?: string) => Promise<LayerFSFolderRecord>
    validateWork: (key: string) => void
  }) {}
  close(): void { this.closed = true }
  revokeContexts(): Promise<void> {
    this.close()
    this.revocation ??= (async () => { await this.options.revokeContexts?.([...this.contextTargets.values()]); this.contextTargets.clear() })()
    return this.revocation
  }
  get localExecutionAllowed(): boolean { return this.options.localExecutionAllowed !== false }
  private bound(workspace: string): LayerFSFolderRecord | undefined {
    const folders = this.options.folders()
    if (workspace.startsWith('layerfs:')) return folders.find((f): f is LayerFSFolderRecord => f.kind === 'layerfs' && f.mount === workspace)
    const selected = selectFolder(folders, workspace)
    return selected.kind === 'layerfs' ? selected : undefined
  }
  location(input: Record<string, unknown>, context: ExecutionContext, sourceBinding?: string): { target: RemoteLayerFSTarget; workspace?: string } | undefined {
    if (this.closed) throw new ToolNoEffectError('LayerFS Project gateway closed; no stale context or fallback')
    if (context.projectId !== this.options.projectId) throw new ToolNoEffectError('LayerFS Project mismatch')
    const selected = sourceBinding ?? (typeof input.workspace === 'string' ? input.workspace : context.layerfsWorkdir?.workspace)
    const folder = selected ? this.bound(selected) : undefined
    if (folder?.location) {
      const target = this.options.target(folder.location.nodeId)
      if (target.pairingId !== folder.location.pairingId || target.projectScope !== folder.location.projectScope) throw new ToolNoEffectError('LayerFS target pairing/Project changed; retained workspace was not adopted')
      return { target, workspace: folder.mount }
    }
    if (selected) return undefined
    if (context.remoteWorkdir) return { target: this.options.target(context.remoteWorkdir.nodeId) }
    return undefined
  }
  async tryCall(action: RemoteLayerFSAction, input: Record<string, unknown>, context: ExecutionContext, sourceBinding?: string, observe?: (text: string) => void): Promise<ToolResult | undefined> {
    const release = this.options.acquireAccess?.()
    try { return await this.dispatchCall(action, input, context, sourceBinding, observe) } finally { release?.() }
  }
  private async dispatchCall(action: RemoteLayerFSAction, input: Record<string, unknown>, context: ExecutionContext, sourceBinding?: string, observe?: (text: string) => void): Promise<ToolResult | undefined> {
    const selected = this.location(input, context, sourceBinding)
    if (!selected) return undefined
    const branchAction = ['ensure_ready', 'read', 'write', 'search', 'exec', 'status', 'mkdir', 'rm', 'cp', 'mv', 'apply', 'diff_files', 'blame', 'branches', 'history', 'diff_commits'].includes(action)
    const args = { ...input, ...(branchAction && selected.workspace ? { workspace: selected.workspace } : {}) }
    if (sourceBinding) delete args.workspace
    let requestId: string | undefined
    const client = new RemoteLayerFSClient(selected.target, this.options.executor, this.options.verify, id => {
      if (action === 'bootstrap' && this.options.jobs) { this.options.jobs.reserve(selected.target, id, input.approval); requestId = id }
      if (action === 'runtime_context') this.contextTargets.set(JSON.stringify(selected.target), { ...selected.target })
    }, observe)
    let result: unknown
    try { result = await client.call(action, args, context) }
    catch (error) { if (requestId && error instanceof ToolNoEffectError) this.options.jobs!.refused(selected.target, requestId); throw error }
    if (action === 'bootstrap_plan' || action === 'setup_plan') this.options.consent?.remember(selected.target, context, result)
    if (action === 'bootstrap' && requestId) {
      const running = targetBootstrapResult.safeParse(result)
      if (!running.success || running.data.result.targetNodeId !== selected.target.nodeId) throw new ToolOutcomeUnknownError('Target bootstrap admission response invalid; Main deletion guard retained. Inspect v:project/remote-layerfs-jobs and target status; do not replay.')
      this.options.jobs!.admitted(selected.target, requestId, running.data.result.targetJobId)
    }
    if (action === 'bootstrap_reconcile' && this.options.jobs) {
      const reconciled = this.options.jobs.release(selected.target, result)
      result = { ...reconciled.proof, projectReservationsReleased: reconciled.released }
    }
    if (action === 'reconcile') {
      const receipt = remoteLayerFSReceiptSchema.safeParse(result)
      if (receipt.success && receipt.data.requestId === input.requestId && receipt.data.phase === 'completed'
        && receipt.data.authority?.nodeId === selected.target.nodeId && receipt.data.authority.pairingId === selected.target.pairingId && receipt.data.authority.projectScope === selected.target.projectScope) {
        if (receipt.data.authority.action === 'bootstrap' && this.options.jobs) {
          const running = targetBootstrapResult.parse(receipt.data.result)
          if (running.result.targetNodeId !== selected.target.nodeId) throw new ToolOutcomeUnknownError('Target bootstrap reconciliation node mismatch')
          this.options.jobs.admitted(selected.target, receipt.data.requestId, running.result.targetJobId)
        }
        this.options.settleRequest?.(receipt.data.requestId)
      }
    }
    const text = JSON.stringify(result)
    return result && typeof result === 'object' && 'ok' in result && result.ok === false ? completedToolFailure({ isError: true, content: [{ type: 'text', text }] }) : text
  }
  wrap(tool: Tool<ToolResult>): Tool<ToolResult> {
    const action = tool.name.replace(/^layerfs_(?:fs_)?/, '') as RemoteLayerFSAction
    if (!remoteLayerFSActions.includes(action)) return tool
    return { ...tool, supportsRemoteWorkdir: true, execute: async (input, context) => await this.tryCall(action, input, context) ?? await tool.execute(input, context) }
  }
  async createWorkspace(input: Record<string, unknown>, context: ExecutionContext, sourceBinding?: string): Promise<string | undefined> {
    const release = this.options.acquireAccess?.()
    try { return await this.createRegisteredWorkspace(input, context, sourceBinding) } finally { release?.() }
  }
  private async createRegisteredWorkspace(input: Record<string, unknown>, context: ExecutionContext, sourceBinding?: string): Promise<string | undefined> {
    const selected = this.location({}, context, sourceBinding)
    if (!selected) return undefined
    const args = { ...input }
    if (args.workKey !== undefined) { this.options.validateWork(String(args.workKey)); delete args.workKey }
    if (sourceBinding) args.sourceBinding = sourceBinding
    const result = await new RemoteLayerFSClient(selected.target, this.options.executor, this.options.verify).call(sourceBinding ? 'workspace_fork' : 'workspace_create', args, context) as Record<string, unknown>
    if (typeof result.workspaceId !== 'string' || !result.workspaceId.startsWith('layerfs:')) throw new Error('Target workspace binding receipt missing; inspect target, do not replay')
    const folder = await this.options.register(result.workspaceId, { version: 1, ...selected.target }, context, typeof result.description === 'string' ? result.description : undefined)
    return JSON.stringify({ ...result, workspaceId: folder.id, targetNodeId: selected.target.nodeId, ...(input.workKey ? { workKey: input.workKey } : {}) })
  }
}
const gateways = new Map<string, RemoteLayerFSGateway>()
const key = (project: string, home: string) => `${resolve(home)}\0${project}`
export function registerRemoteLayerFSGateway(project: string, home: string, gateway: RemoteLayerFSGateway): () => void {
  const id = key(project, home)
  if (gateways.has(id)) throw new Error('LayerFS gateway already registered')
  gateways.set(id, gateway)
  return () => { gateway.close(); if (gateways.get(id) === gateway) gateways.delete(id) }
}
export function remoteLayerFSGateway(project: string, home?: string): RemoteLayerFSGateway | undefined { return home ? gateways.get(key(project, home)) : undefined }
