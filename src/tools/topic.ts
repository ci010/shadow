import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'
import type { TopicService } from '../sessions/topics.ts'

export class TopicTool implements Tool {
  readonly name = 'topic'
  readonly supportsRemoteWorkdir = true
  readonly description = 'Create an independent, user-visible topic chat in this Project, revise its brief, or register an existing local folder. First search space="sessions:" to reuse an existing topic and read v:project/folders to select a folder ID. Topics are peers, not children; creation never transfers Initiative assignments. Use message for subsequent communication.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'update', 'register_folder'] },
      title: { type: 'string', description: 'Required for create/update: concise topic name (max 160 characters).' },
      goal: { type: 'string', description: 'Required for create/update: intended outcome and acceptance criteria.' },
      scope: { type: 'string', description: 'Required for create/update: owned domain/resources; a brief is not an exclusive Initiative claim.' },
      nonGoals: { type: 'string', description: 'Explicitly excluded work.' },
      sessionId: { type: 'string', description: 'Update only: this topic or a topic managed by the coordinator.' },
      requestId: { type: 'string', description: 'Create only: optional UUID; reuse exactly the same request on retry. Initial messages are never replayed.' },
      folderId: { type: 'string', description: 'Create only: registered Project folder ID. Omit for a discussion-only topic; never a path.' },
      agentType: { type: 'string', description: 'Create only: agent template name, default general. Never orchestrator.' },
      initiativeId: { type: 'string', description: 'Create only: existing shared Initiative ID, optional; not an assignment.' },
      initialMessage: { type: 'string', description: 'Create only: optional kickoff request, with the necessary context and source references.' },
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
      if (context.remoteWorkdir) throw new Error('A remote topic cannot register its display path on Main. Ask the Project coordinator to register a Main-local folder or select an existing remote capability.')
      if (Object.keys(request).some(key => key !== 'path')) throw new TypeError('register_folder accepts only path.')
      return JSON.stringify(await this.topics.registerFolder(request.path, context.signal))
    }
    throw new TypeError('Unknown topic action.')
  }
}
