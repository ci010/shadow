import type { Tool, ToolParameters } from './tool.ts'
import type { ExecutionContext } from './context.ts'
import type { DerivedWorkspaceCreator } from '../folders/derived-workspace.ts'
import type { FolderRegistry } from '../folders/registry.ts'
import { selectFolder } from '../folders/identifier.ts'
import { parseBranchWorkspace } from '../execution/layerfs/workspace-identity.ts'

/** Stable registered-source facade; backend services retain ownership of mutation/recovery. */
export class WorkspaceForkTool implements Tool {
  readonly name = 'workspace_fork'
  readonly supportsLayerFSWorkdir = true
  readonly description = 'Fork a registered current-Project Workspace without switching this session. auto inherits LayerFS for a LayerFS source; otherwise uses git-worktree (including Windows/remote Git). Git requires baseRef (existing local/remote-tracking branch), generates an independent branch, and never copies dirty files or fetches. LayerFS inherits the exact bound source branch; newBranch optionally names the new branch. No implicit setup/import/install or backend fallback. Reuse idempotencyKey for recovery; uncertain mutations are not replayed. LayerFS writes checkpoint, exec mounts/checkpoints/unmounts; no export to original checkout. workspace_create remains available with its legacy backend-specific source contract.'
  readonly parameters: ToolParameters = {
    type: 'object', additionalProperties: false, required: ['source'], properties: {
      source: { type: 'string', description: 'Registered current-Project Workspace selector, never a path or raw branch.' },
      backend: { type: 'string', enum: ['auto', 'git-worktree', 'layerfs'], description: 'Default auto: inherit LayerFS, otherwise Git.' },
      baseRef: { type: 'string', description: 'Git only: required existing base branch. LayerFS always inherits its registered binding; overrides are refused.' },
      newBranch: { type: 'string', description: 'LayerFS only: optional new branch name. Git always generates a safe independent branch.' },
      ...Object.fromEntries(['description', 'name', 'workKey', 'idempotencyKey'].map(key => [key, { type: 'string' as const }])),
    },
  }
  constructor(private readonly git: DerivedWorkspaceCreator, private readonly projectId: string,
    private readonly canCreate: (id: string) => boolean,
    private readonly folders: Pick<FolderRegistry, 'list' | 'requireExecutionAvailable' | 'acquireAccess'> & Partial<Pick<FolderRegistry, 'recordLineage'>>,
    private readonly layerfs: (args: Record<string, unknown>, context: ExecutionContext, binding: string) => Promise<string>) {}

  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    if (context.projectId !== this.projectId || !this.canCreate(context.sessionId)) throw new Error('Workspace creation is unavailable in this execution context.')
    for (const [key, value] of Object.entries(args)) {
      if (!Object.hasOwn(this.parameters.properties, key) || typeof value !== 'string' || value.length > 2000 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid workspace fork parameters.')
    }
    if (typeof args.source !== 'string' || !args.source) throw new Error('Registered source Workspace is required.')
    const backend = args.backend ?? 'auto'
    if (!['auto', 'git-worktree', 'layerfs'].includes(String(backend))) throw new Error('Unsupported workspace backend; no fallback.')
    const release = this.folders.acquireAccess()
    try {
      const selected = selectFolder(this.folders.list(), args.source)
      const source = await this.folders.requireExecutionAvailable(selected.id, context.signal)
      const target = backend === 'auto' ? source.kind === 'layerfs' ? 'layerfs' : 'git-worktree' : backend
      const common = Object.fromEntries(['description', 'name', 'workKey', 'idempotencyKey'].filter(key => args[key] !== undefined).map(key => [key, args[key]]))
      if (target === 'layerfs') {
        if (source.kind !== 'layerfs') throw new Error('LayerFS fork requires a prepared/imported registered LayerFS Workspace. Complete explicit LayerFS setup/import first; no implicit import or Git fallback.')
        const binding = parseBranchWorkspace(source.mount)
        if (args.baseRef !== undefined) throw new Error('LayerFS baseRef override is refused; source is the registered branch binding.')
        const result = await this.layerfs({ ...common, source: binding.branch, ...(args.newBranch !== undefined ? { branch: args.newBranch } : {}) }, context, source.mount)
        const receipt = JSON.parse(result)
        if (typeof receipt.workspaceId !== 'string') throw new Error('LayerFS fork registration receipt missing')
        await this.folders.recordLineage?.(receipt.workspaceId, { version: 1, parentId: source.id, backend: 'layerfs', ownership: 'shadow-derived' })
        return result
      }
      if (source.kind === 'layerfs') throw new Error('LayerFS source cannot use git-worktree; no host fallback.')
      if (args.newBranch !== undefined) throw new Error('Git fork generates its branch; newBranch is LayerFS-only.')
      if (typeof args.baseRef !== 'string' || !args.baseRef) throw new Error('Git fork requires baseRef (existing branch).')
      return JSON.stringify(await this.git.createDerivedWorkspace({ ...common, source: source.id, branch: args.baseRef }, context.signal))
    } finally { release() }
  }
}
