import { parseSql } from '../initiatives/sql.ts'
import { parseConventionSource, PROJECT_SQL_HELP, type ConventionAuthority, type ConventionSource, type ProjectConventions } from '../projects/conventions.ts'
import type { ExecutionContext } from './context.ts'
import type { Tool, ToolParameters } from './tool.ts'

export class SqlTool implements Tool {
  readonly name = 'sql'
  readonly supportsRemoteWorkdir = true
  readonly readonly = (args: Record<string, unknown>) => {
    try { return args.query === undefined || typeof args.query === 'string' && parseSql(args.query).every(statement => statement.operation === 'SELECT') }
    catch { return false }
  }
  readonly description = 'Query current Project work and Project conventions. Omit query for the bounded SQL schema. Work/audit tables are read-only. Convention writes require a direct Project-admin human instruction or an exact human-selected decision, not inferred preferences. Project and actor are runtime-bound; remote workdirs never change storage scope.'
  readonly parameters: ToolParameters = {
    type: 'object', properties: {
      query: { type: 'string', description: 'Bounded Project SQL. Omit for schema and source guidance.' },
      source: { type: 'object', description: 'Convention mutations only: recorded user evidence or human decision reference; see sql schema.' },
    }, additionalProperties: false,
  }

  constructor(private readonly store: ProjectConventions, private readonly projectId: string,
    private readonly authorize: (source: ConventionSource, context: ExecutionContext) => Promise<ConventionAuthority>,
    private readonly changed?: () => void) {}

  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    context.signal.throwIfAborted()
    if (!this.projectId || context.projectId !== this.projectId || !context.sessionId) throw new Error('SQL requires the owning Project and a runtime session identity.')
    const denied = context.tools.executionDenial('sql', args)
    if (denied) return denied
    if (Object.keys(args).some(key => !['query', 'source'].includes(key))) throw new TypeError('sql accepts only query and source, never actor or Project arguments.')
    if (args.query === undefined && args.source === undefined) return JSON.stringify(PROJECT_SQL_HELP)
    if (typeof args.query !== 'string' || !args.query.trim()) throw new TypeError('query must be nonempty SQL.')
    const mutations = !parseSql(args.query).every(statement => statement.operation === 'SELECT')
    if (!mutations && args.source !== undefined) throw new TypeError('SELECT does not take source.')
    let authority: ConventionAuthority | undefined
    if (mutations) {
      if (!context.admin || context.inputSource !== 'user' || context.channel === 'a2a') throw new Error('Convention changes require a direct Project-admin human turn; delegated, event and remote-agent turns are not authority.')
      authority = await this.authorize(parseConventionSource(args.source), context)
    }
    context.signal.throwIfAborted()
    const result = this.store.query(args.query, context.sessionId, authority, context.signal)
    if (result.changes) this.changed?.()
    return JSON.stringify(result)
  }
}
