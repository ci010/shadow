import { prepareWorkingContext } from '../agent/context/working-context.ts'
import type { FolderRegistry } from '../folders/registry.ts'
import { selectFolder } from '../folders/identifier.ts'
import { localFolderWorkdirRef } from '../sessions/locality.ts'
import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'

export class UseProjectTool implements Tool {
  readonly name = 'use_project'
  readonly supportsRemoteWorkdir = true
  readonly description = 'Set a registered Folder in the current Project as this session\'s ongoing working context, switching the default cwd and folder-scoped instructions together. Use when this session will keep working in that folder, not as a prerequisite for every folder task. For cross-folder work, consider explicit paths or separate folder-bound subagents/sessions instead of serial switching; choose what fits the task. Use the short identifier from Project folders or its full folder ID, never a path. Call alone, directly, not in a parallel batch or script. Applies to subsequent calls only; running processes and children retain their context. Does not change Project scope.'
  readonly parameters: ToolParameters = {
    type: 'object', properties: { folder: { type: 'string', description: 'Unique short folder name (for example app or docs), name-ID selector from discovery, or full folder ID.' } },
    required: ['folder'], additionalProperties: false,
  }
  constructor(private readonly options: {
    projectId: string
    folders: Pick<FolderRegistry, 'list' | 'requireAvailable' | 'requireExecutionAvailable' | 'acquireAccess'>
    switched?: (context: ExecutionContext) => void
  }) {}

  selectedFolder(id: string) { return this.options.folders.list().find(folder => folder.id === id) }

  async executionTargetFolder(identifier: string, signal: AbortSignal) {
    signal.throwIfAborted()
    const selected = selectFolder(this.options.folders.list(), identifier)
    return this.options.folders.requireExecutionAvailable(selected.id, signal)
  }

  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    if (context.projectId !== this.options.projectId) throw new Error('Project context mismatch.')
    if (!context.switchProjectFolder || context.scriptInvocation || context.toolCallName !== this.name) {
      throw new Error('use_project must be the sole direct top-level tool call. Retry it alone; no state changed.')
    }
    if (typeof args.folder !== 'string' || !args.folder || Object.keys(args).some(key => key !== 'folder')) throw new Error('Expected only folder identifier.')
    const release = this.options.folders.acquireAccess()
    try {
      context.signal.throwIfAborted()
      const target = selectFolder(this.options.folders.list(), args.folder)
      const folder = await this.options.folders.requireAvailable(target.id, context.signal)
      // Capability availability alone does not provide remote instruction reads.
      if (folder.kind === 'remote') throw new Error('Remote folder switching is unavailable: scoped instruction preparation is not implemented on that executor. Prior working context retained; no Main fallback.')
      const content = await prepareWorkingContext({ available: true, locality: 'local', path: folder.path, workdir: localFolderWorkdirRef(folder.id) }, folder.id, folder, context.signal, context.admin)
      context.signal.throwIfAborted()
      const receipt = await context.switchProjectFolder({ folderId: folder.id, workdir: localFolderWorkdirRef(folder.id), content })
      this.options.switched?.(context)
      return receipt
    } finally { release() }
  }
}
