import type { Tool, ToolParameters } from './tool.ts'
import type { ExecutionContext } from './context.ts'
import type { DerivedWorkspaceCreator, DerivedWorkspaceRequest } from '../folders/derived-workspace.ts'

export class WorkspaceCreateTool implements Tool {
  readonly name = 'workspace_create'
  readonly description = 'Create and register a derived git-worktree Workspace in the current Project, beside a registered source repository, from a local or existing remote-tracking branch. Creates a host-generated independent branch at a fixed commit; never copies dirty files, fetches, or switches this session. Optional Work association does not claim Work. Reuse an idempotencyKey for safe retries; remote sources are unsupported.'
  readonly parameters: ToolParameters = {
    type: 'object', additionalProperties: false, required: ['source', 'branch'], properties: {
      source: { type: 'string', description: 'Registered current-Project Workspace selector; not a path.' },
      branch: { type: 'string', description: 'Local branch or existing remote-tracking branch (explicit refs/heads or refs/remotes accepted).' },
      description: { type: 'string', description: 'Optional user description; source/worktree identity is always added.' },
      workKey: { type: 'string', description: 'Optional existing current-Project Work key; association only.' },
      name: { type: 'string', description: 'Optional safe directory name prefix; host adds a unique suffix.' },
      idempotencyKey: { type: 'string', description: 'Stable request key for retry/recovery; changing parameters with the same key fails.' },
    },
  }
  constructor(private readonly service: DerivedWorkspaceCreator, private readonly projectId: string, private readonly canCreate: (id: string) => boolean) {}
  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    if (context.projectId !== this.projectId || !this.canCreate(context.sessionId)) throw new Error('Workspace creation is unavailable in this execution context.')
    return JSON.stringify(await this.service.createDerivedWorkspace(args as unknown as DerivedWorkspaceRequest, context.signal))
  }
}
