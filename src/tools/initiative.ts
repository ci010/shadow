import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'

export interface InitiativeDatabase {
  query(sql: string, actorSessionId: string, signal?: AbortSignal): unknown | Promise<unknown>
}

export class InitiativeTool implements Tool {
  readonly name = 'initiative'
  readonly optIn = true
  readonly supportsRemoteWorkdir = true
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'SQL against the current Project initiative database. A mutation batch is atomic. Check affected row counts when claiming or updating work.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  }
  readonly description: string

  constructor(
    private readonly database: InitiativeDatabase,
    private readonly projectId: string,
    schema: string,
  ) {
    this.description = 'Query and maintain cross-session initiatives, items, dependencies, and progress in this Project. ' +
      'Project scope and the acting logical session are supplied by the runtime, not SQL arguments. ' +
      'This is shared work state, not another session todo list. Updating a status does not execute a task. ' +
      'Data remains in Project Home even when this session works in a remote folder.\n' + schema
  }

  async execute(
    args: Record<string, unknown>,
    context: Pick<ExecutionContext, 'projectId' | 'sessionId' | 'signal'>,
  ): Promise<string> {
    context.signal.throwIfAborted()
    if (!this.projectId || context.projectId !== this.projectId) {
      throw new Error('Initiative access requires the owning Project context.')
    }
    if (!context.sessionId) throw new TypeError('A logical session ID is required for initiative operations.')
    if (Object.keys(args).some(key => key !== 'query')) {
      throw new TypeError('initiative accepts only query; its Project and actor cannot be selected through arguments.')
    }
    if (typeof args.query !== 'string' || !args.query.trim()) {
      throw new TypeError('query must be a non-empty SQL string.')
    }
    return JSON.stringify(await this.database.query(args.query, context.sessionId, context.signal))
  }

  getChatTextDisplay(): string {
    return 'Initiative work records'
  }
}
