import { FILESYSTEM_READ_OPERATION } from '../execution/capability-filesystem.ts'
import { executeRemoteFilesystemText, RemoteFilesystemError } from '../execution/remote-filesystem-client.ts'
import { executionTargetParameters, workspaceArguments } from './execution-target.ts'
import { prepareWorkingContext } from '../agent/context/working-context.ts'
import type { LayerFSFolderRecord } from '../folders/contracts.ts'
import type { FolderRegistry } from '../folders/registry.ts'
import { selectFolder } from '../folders/identifier.ts'
import { localFolderWorkdirRef } from '../sessions/locality.ts'
import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'

export class UseProjectTool implements Tool {
  readonly name = 'workspace_use'
  readonly supportsLayerFSWorkdir = true
  readonly supportsRemoteWorkdir = true
  readonly description = 'Set a registered Workspace in the current Project as this session\'s ongoing working context, switching the default cwd and workspace-scoped instructions together. Use when this session will keep working in that workspace, not as a prerequisite for every workspace task. For cross-workspace work, consider explicit paths or separate workspace-bound subagents/sessions instead of serial switching; choose what fits the task. Use the short identifier from Project workspaces or its full workspace ID, never a path. Call alone, directly, not in a parallel batch or script. Applies to subsequent calls only; running processes and children retain their context. Does not change Project scope.'
  readonly parameters: ToolParameters = {
    type: 'object', properties: executionTargetParameters,
    required: ['workspace'], additionalProperties: false,
  }
  constructor(private readonly options: {
    projectId: string
    folders: Pick<FolderRegistry, 'list' | 'requireAvailable' | 'requireExecutionAvailable' | 'acquireAccess'>
    readLayerFSInstructions?: (folder: LayerFSFolderRecord, context: ExecutionContext) => Promise<{ content: string }>
    beforeSwitch?: (context: ExecutionContext, folderId: string) => Promise<void>
    switched?: (context: ExecutionContext) => void
  }) {}

  selectedFolder(id: string) { return this.options.folders.list().find(folder => folder.id === id) }

  async executionTargetFolder(identifier: string, signal: AbortSignal) {
    signal.throwIfAborted()
    const selected = selectFolder(this.options.folders.list(), identifier)
    return this.options.folders.requireExecutionAvailable(selected.id, signal)
  }

  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    args = workspaceArguments(args)
    if (context.projectId !== this.options.projectId) throw new Error('Project context mismatch.')
    if (!context.switchProjectFolder || context.scriptInvocation || context.toolCallName !== this.name) {
      throw new Error('workspace_use must be the sole direct top-level tool call. Retry it alone; no state changed.')
    }
    if (typeof args.workspace !== 'string' || !args.workspace || Object.keys(args).some(key => key !== 'workspace')) throw new Error('Expected only workspace identifier.')
    const release = this.options.folders.acquireAccess()
    try {
      context.signal.throwIfAborted()
      const target = selectFolder(this.options.folders.list(), args.workspace)
      const folder = await this.options.folders.requireAvailable(target.id, context.signal)
      const workdir = folder.kind === 'remote' || folder.kind === 'layerfs' ? folder.workdir : localFolderWorkdirRef(folder.id)
      let remoteInstructions: { content: string } | undefined
      if (folder.kind === 'layerfs') {
        if (!this.options.readLayerFSInstructions) throw new Error('LayerFS workspace instruction reader unavailable; prior working context retained.')
        remoteInstructions = await this.options.readLayerFSInstructions(folder, context)
      } else if (folder.kind === 'remote') {
        if (!context.resolveToolTarget) throw new Error('Remote workspace instruction reads are unavailable; prior working context retained.')
        const resolved = await context.resolveToolTarget(folder.id, FILESYSTEM_READ_OPERATION)
        const remote = resolved.remoteWorkdir
        if (!remote || remote.nodeId !== workdir.nodeId || remote.workdirId !== workdir.workdirId) throw new Error('Remote workspace target changed during preparation; no state changed.')
        context.signal.throwIfAborted()
        let instructions = ''
        try {
          instructions = await executeRemoteFilesystemText({ ...remote, sessionId: context.sessionId,
            turnId: context.toolCallId ?? crypto.randomUUID(), signal: context.signal }, FILESYSTEM_READ_OPERATION,
          { path: 'AGENTS.md', kind: 'file' }, 128_000)
        } catch (error) {
          if (!(error instanceof RemoteFilesystemError) || error.code !== 'file-not-found') throw error
        }
        remoteInstructions = { content: instructions }
      }
      const content = await prepareWorkingContext(folder.kind === 'layerfs'
        ? { available: true, locality: 'layerfs', workdir, workspace: folder.mount }
        : folder.kind === 'remote'
        ? { available: true, locality: 'remote', workdir }
        : { available: true, locality: 'local', path: folder.path, workdir }, folder.id, folder, context.signal, context.admin, remoteInstructions, context)
      // Revalidate after asynchronous instruction reads, while retaining ownership access.
      const current = await this.options.folders.requireAvailable(folder.id, context.signal)
      const currentRef = current.kind === 'remote' || current.kind === 'layerfs' ? current.workdir : localFolderWorkdirRef(current.id)
      if (currentRef.nodeId !== workdir.nodeId || currentRef.workdirId !== workdir.workdirId || current.path !== folder.path) throw new Error('Workspace target changed during preparation; no state changed.')
      context.signal.throwIfAborted()
      await this.options.beforeSwitch?.(context, folder.id)
      context.signal.throwIfAborted()
      const receipt = await context.switchProjectFolder({ folderId: folder.id, workdir, content })
      this.options.switched?.(context)
      return receipt
    } finally { release() }
  }
}
