import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'
import type { TopicService } from '../sessions/topics.ts'
import { REASONING_EFFORTS } from '../agent/llm-config.ts'

export class SessionTool implements Tool {
  readonly name = 'session'
  readonly supportsRemoteWorkdir = true
  readonly description = 'Create durable peer conversations and register folders. Read/write v:session/self.json for your own metadata/completion. Optionally supply work:{key} for an existing unassigned note you coordinate; the host links and assigns it before initialMessage. Work is a shared notebook, not an execution requirement. Keep goals and rationale in the note, and give the peer only the local objective, constraints and stop condition.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'update', 'register_folder'] },
      topic: { type: 'string', description: 'Required for create/update: stable overarching conversation topic, max 120 characters.' },
      focus: { type: 'string', description: 'Optional current step, max 4000 characters. Display falls back to topic when empty.' },
      description: { type: 'string', description: 'Folder contents description for register_folder only. Not instructions or permission.' },
      sessionId: { type: 'string', description: 'Update only: this session.' },
      requestId: { type: 'string', description: 'Create only: optional UUID; reuse exactly the same request on retry. Initial messages are never replayed.' },
      folderId: { type: 'string', description: 'Create only: current Project folder shortName, name-ID selector or full UUID. Uses the registered folder and its node. Omit for a discussion-only session; never a path.' },
      agentType: { type: 'string', description: 'Create only: agent template name, default general.' },
      model: { type: 'string', description: 'Create only: optional exact model ID from v:models; omission preserves agent/Project defaults.' },
      effort: { type: 'string', enum: [...REASONING_EFFORTS], description: 'Create only: optional reasoning effort supported by the selected model; omission preserves agent/Project defaults.' },
      workRoot: { type: 'string', description: 'Create only: optional root Work key for shared context; not an assignment. Omit for ordinary conversations.' },
      initialMessage: { type: 'string', description: 'Create only: optional kickoff request, with the necessary context and source references.' },
      work: { type: 'object', description: 'Create only: {key:string}, an unassigned note coordinated by this session. Link responsibility and contextual questions before kickoff; no adoption protocol.' },
      nodeId: { type: 'string', description: 'register_folder only: explicit runtime inventory device identity (Main or Child). Required from remote sessions; never inferred from a display path.' },
      path: { type: 'string', description: 'register_folder only: absolute existing directory on Main when nodeId is omitted; otherwise an opaque directory path on the explicitly selected device. This does not move data or change this chat workdir.' },
    },
    required: ['action'],
    additionalProperties: false,
  }
  constructor(private readonly topics: TopicService) {}

  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    context.signal.throwIfAborted()
    const { action, ...request } = args
    this.topics.assertActor(context.projectId, context.sessionId, true)
    if (action === 'update' && request.sessionId !== undefined && request.sessionId !== context.sessionId) throw new Error('Session tools can only update their own metadata.')
    if (action === 'create') return JSON.stringify(await this.topics.create(request, context.sessionId, context.signal))
    if (action === 'update') return JSON.stringify(await this.topics.update(request, context.sessionId))
    if (action === 'register_folder') {
      if (context.remoteWorkdir && request.nodeId === undefined) throw new Error('A remote session cannot register its display path on Main. Use a Main-local Project session to register a Main-local folder or select an existing remote capability.')
      if (Object.keys(request).some(key => key !== 'path' && key !== 'description' && key !== 'nodeId')) throw new TypeError('register_folder accepts only path, description and nodeId.')
      return JSON.stringify(await this.topics.registerFolder(request.path, context.signal, request.description as string | undefined, request.nodeId))
    }
    throw new TypeError('Unknown session action.')
  }
}
