import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'
import type { TopicService } from '../sessions/topics.ts'

export class SessionTool implements Tool {
  readonly name = 'session'
  readonly supportsRemoteWorkdir = true
  readonly description = 'Create durable peer conversations, update your own metadata/completion with update_self, and register folders. Optionally supply work:{key} for an existing unassigned note you coordinate; the host links and assigns it before initialMessage. Work is a shared notebook, not an execution requirement. Keep goals and rationale in the note, and give the peer only the local objective, constraints and stop condition.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'update', 'update_self', 'register_folder'] },
      completed: { type: 'boolean', description: 'update_self only: explicitly mark the current responsibility complete (not Work complete) or reopen it; independent of inferred running/waiting activity.' },
      title: { type: 'string', description: 'Required for create/update; optional for durable update_self (task titles are parent-owned): session name, max 120 characters.' },
      description: { type: 'string', description: 'Optional short discovery description, not a goal, acceptance condition or permission.' },
      sessionId: { type: 'string', description: 'Update only: this session. update_self accepts no sessionId.' },
      requestId: { type: 'string', description: 'Create only: optional UUID; reuse exactly the same request on retry. Initial messages are never replayed.' },
      folderId: { type: 'string', description: 'Create only: registered Project folder ID. Omit for a discussion-only session; never a path.' },
      agentType: { type: 'string', description: 'Create only: agent template name, default general. Never orchestrator.' },
      initiativeId: { type: 'string', description: 'Create only: root Work key for an Initiative view (or a legacy Initiative ID), optional; not an assignment.' },
      initialMessage: { type: 'string', description: 'Create only: optional kickoff request, with the necessary context and source references.' },
      work: { type: 'object', description: 'Create only: {key:string}, an unassigned note coordinated by this session. Link responsibility and contextual questions before kickoff; no adoption protocol.' },
      path: { type: 'string', description: 'register_folder only: absolute existing directory on Main. This does not move data or change this chat workdir.' },
    },
    required: ['action'],
    additionalProperties: false,
  }
  constructor(private readonly topics: TopicService) {}

  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    context.signal.throwIfAborted()
    const { action, ...request } = args
    this.topics.assertActor(context.projectId, context.sessionId, action !== 'update_self')
    if (action === 'update_self') return JSON.stringify(await this.topics.updateSelf(request, context.sessionId))
    if (action === 'update' && request.sessionId !== undefined && request.sessionId !== context.sessionId) throw new Error('Session tools can only update their own metadata.')
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
