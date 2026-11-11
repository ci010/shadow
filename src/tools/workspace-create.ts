import type { Tool, ToolParameters } from './tool.ts'
import type { ExecutionContext } from './context.ts'
import type { DerivedWorkspaceCreator, DerivedWorkspaceRequest } from '../folders/derived-workspace.ts'

export class WorkspaceCreateTool implements Tool {
  readonly name = 'workspace_create'
  readonly supportsLayerFSWorkdir = true
  readonly description = 'Create an isolated workspace with backend git-worktree (default) or layerfs. Git: source is a registered repository Workspace, branch is an existing local/remote-tracking base; creates and registers an independent worktree at a fixed commit, never copies dirty files or fetches. LayerFS: source is an already-imported LayerFS branch (e.g. main); optional branch names the NEW branch, otherwise generated. Forks, mounts and registers a non-host Workspace in one operation; returns workspaceId for ordinary read/write/search/exec or workspace_use. LayerFS setup/import must already be complete; no provisioning or import is implicit. Both backends accept description/name/workKey/idempotencyKey. LayerFS does not export back to the original checkout. Neither backend switches this session. Reuse idempotencyKey for recovery; uncertain mutations are never replayed.'
  readonly parameters: ToolParameters = {
    type: 'object', additionalProperties: false, required: ['source'], properties: {
      backend: { type: 'string', enum: ['git-worktree', 'layerfs'], description: 'Workspace isolation backend; default git-worktree. LayerFS must already be set up and its source imported.' },
      source: { type: 'string', description: 'Git: registered current-Project repository Workspace selector. LayerFS: existing imported LayerFS branch name, such as main. Never a host path.' },
      branch: { type: 'string', description: 'Git: required existing base branch (local or remote-tracking). LayerFS: optional NEW branch name; generated when omitted.' },
      description: { type: 'string', description: 'Optional user description; source/worktree identity is always added.' },
      workKey: { type: 'string', description: 'Optional existing current-Project Work key; association only.' },
      name: { type: 'string', description: 'Optional safe directory name prefix; host adds a unique suffix.' },
      idempotencyKey: { type: 'string', description: 'Stable request key for retry/recovery; changing parameters with the same key fails.' },
    },
  }
  constructor(private readonly service: DerivedWorkspaceCreator, private readonly projectId: string, private readonly canCreate: (id: string) => boolean,
    private readonly layerfs?: (args: Record<string, unknown>, context: ExecutionContext) => Promise<string>) {}
  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    if (context.projectId !== this.projectId || !this.canCreate(context.sessionId)) throw new Error('Workspace creation is unavailable in this execution context.')
    const { backend = 'git-worktree', ...request } = args
    if (backend === 'layerfs') {
      if (!this.layerfs) throw new Error('LayerFS workspace creation is unavailable; no Git or host fallback.')
      return this.layerfs(request, context)
    }
    if (backend !== 'git-worktree') throw new Error('Unsupported workspace backend; no fallback.')
    return JSON.stringify(await this.service.createDerivedWorkspace(request as unknown as DerivedWorkspaceRequest, context.signal))
  }
}
