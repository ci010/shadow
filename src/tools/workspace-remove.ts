import { isDirectOwnerTurn } from '../sessions/owner-policy.ts'
import type { Tool, ToolParameters } from './tool.ts'
import type { ExecutionContext } from './context.ts'
import type { ProjectCatalog } from '../projects/catalog.ts'
import { UUID_PATTERN } from '../folders/registry.ts'

export class WorkspaceRemoveTool implements Tool {
  readonly name = 'workspace_remove'
  readonly description = 'Remove a registered Shadow-derived local Git worktree from disk AND unregister it in this Project; unlike UI unregister, this deletes the checkout. Explicit user authorization is required. Sole direct admin user call in an owner Web session only, never scripts/remote/LayerFS. Requires exact Workspace UUID and explicit integratedRef (refs/heads/... or refs/remotes/...) containing its latest commit. Rejects primary checkouts, the calling conversation’s Workspace, concurrent Project work, tracked/untracked/ignored files including dependencies/build outputs, unsafe identity/index state and unmerged commits. Never forces removal or deletes the branch. Pre-commit/uncertain failures retain registration and require inspection; errors distinguish disk/registry completion. Never blindly replay.'
  readonly parameters: ToolParameters = {
    type: 'object', additionalProperties: false, required: ['workspaceId', 'integratedRef'], properties: {
      workspaceId: { type: 'string', description: 'Exact registered current-Project Workspace UUID, not a path or selector. Must not be the calling conversation’s selected/delegated Workspace.' },
      integratedRef: { type: 'string', description: 'Explicit intended integration target refs/heads/... or refs/remotes/...; no fetching. Must contain target HEAD by Git ancestry and differ from the retained worktree branch.' },
    },
  }
  constructor(private readonly catalog: Pick<ProjectCatalog, 'removeWorktree'>, private readonly projectId: string, private readonly canRemove: (id: string) => boolean) {}
  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    if (context.projectId !== this.projectId || context.remoteWorkdir || context.layerfsWorkdir || context.scriptInvocation || !context.soleDirectToolCall || context.recoveringToolCall || !isDirectOwnerTurn(context) || !this.canRemove(context.sessionId)) throw new Error('Workspace removal unavailable in this execution context.')
    if (Object.keys(args).some(key => !['workspaceId', 'integratedRef'].includes(key)) || typeof args.workspaceId !== 'string' || !UUID_PATTERN.test(args.workspaceId) || typeof args.integratedRef !== 'string') throw new Error('Expected only exact workspaceId UUID and integratedRef.')
    return JSON.stringify(await this.catalog.removeWorktree(this.projectId, args.workspaceId, args.integratedRef, context.sessionId, context.signal))
  }
}
