import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'
import type { TopicService } from '../sessions/topics.ts'

export class SessionTool implements Tool {
  readonly name = 'session'
  readonly supportsRemoteWorkdir = true
  readonly description = 'Create or name durable peer conversations and register folders. Ordinary peers default to optional Work. To create a managed executor, supply work:{key,revision} for existing unassigned Work you control; the host binds enforcement and assigns it before initialMessage. Required creators must use descendant Work. Metadata never defines scope or transfers existing assignments.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'update', 'register_folder'] },
      title: { type: 'string', description: 'Required for create/update: session name, max 120 characters.' },
      description: { type: 'string', description: 'Optional short discovery description, not a goal, acceptance condition or permission.' },
      sessionId: { type: 'string', description: 'Update only: this session or an ordinary conversation managed by the coordinator.' },
      requestId: { type: 'string', description: 'Create only: optional UUID; reuse exactly the same request on retry. Initial messages are never replayed.' },
      folderId: { type: 'string', description: 'Create only: registered Project folder ID. Omit for a discussion-only session; never a path.' },
      agentType: { type: 'string', description: 'Create only: agent template name, default general. Never orchestrator.' },
      initiativeId: { type: 'string', description: 'Create only: root Work key for an Initiative view (or a legacy Initiative ID), optional; not an assignment.' },
      initialMessage: { type: 'string', description: 'Create only: optional kickoff request, with the necessary context and source references.' },
      work: { type: 'object', description: 'Create only: {key:string,revision:integer}, exact unassigned Work controlled by this session. Enable managed execution before kickoff.' },
      path: { type: 'string', description: 'register_folder only: absolute existing directory on Main. This does not move data or change this chat workdir.' },
    },
    required: ['action'],
    additionalProperties: false,
  }
  constructor(private readonly topics: TopicService) {}

  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    context.signal.throwIfAborted()
    this.topics.assertActor(context.projectId, context.sessionId, true)
    const { action, ...request } = args
    if (action === 'create') return JSON.stringify(await this.topics.create(request, context.sessionId, context.signal))
    if (action === 'update') return JSON.stringify(await this.topics.update(request, context.sessionId))
    if (action === 'register_folder') {
      if (context.remoteWorkdir) throw new Error('A remote session cannot register its display path on Main. Ask the Project coordinator to register a Main-local folder or select an existing remote capability.')
      if (Object.keys(request).some(key => key !== 'path')) throw new TypeError('register_folder accepts only path.')
      return JSON.stringify(await this.topics.registerFolder(request.path, context.signal))
    }
    throw new TypeError('Unknown session action.')
  }
}
