import type { Tool, ToolParameters } from './tool.ts'
import type { ExecutionContext } from './context.ts'
import type { MemoryStore } from '../agent/memory.ts'
import { parseInitiativeId } from '../sessions/initiative-metadata.ts'

/**
 * Add or remove a durable **convention** — an always-on constraint / rule that
 * is injected full-text every turn (see MEM.md "Conventions").
 *
 * Conventions are declared explicitly (not distilled), so this is a deliberate
 * decision, not bookkeeping. Per MEM.md, only the main agent writes conventions;
 * sub-agents receive them read-only (the generic `sub` agent blocks this tool).
 */
export class ConventionTool implements Tool {
  readonly name = 'update_convention'
  readonly description =
    'Add or remove a durable convention (always-on constraint / rule). ' +
    'Conventions are injected full-text every turn — keep them short and remove ' +
    'them when no longer in effect. scope: session (this conversation), initiative ' +
    '(shared work within this Project), or agent (this Project agent). Legacy project scope means initiative, never another Project.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['add', 'remove'],
        description: 'Whether to add or remove a convention.',
      },
      scope: {
        type: 'string',
        enum: ['session', 'initiative', 'agent', 'project'],
        description: 'The scope the convention applies to.',
      },
      text: {
        type: 'string',
        description:
          'The convention text. For remove, a case-insensitive substring match.',
      },
      initiative_id: {
        type: 'string',
        description: 'Initiative ID for initiative scope; defaults to this session association.',
      },
    },
    required: ['action', 'scope', 'text'],
  }

  constructor(
    private memory: MemoryStore,
    private initiativeFor?: (sessionId: string) => string | undefined,
    private assertInitiative?: (initiativeId: string) => void,
  ) {}

  async execute(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<string> {
    const action = String(args.action)
    const scope = args.scope === 'project' ? 'initiative' : args.scope
    if (scope !== 'session' && scope !== 'initiative' && scope !== 'agent') {
      return 'Error: scope must be session, initiative, or agent.'
    }
    const text = String(args.text ?? '').trim()
    if (!text) return 'Error: text is required'

    let key: string | undefined
    if (scope === 'session') {
      key = context.sessionId
    } else if (scope === 'initiative') {
      key = parseInitiativeId({ initiativeId: args.initiative_id, projectName: args.project })
        ?? this.initiativeFor?.(context.sessionId)
      if (!key) return 'Error: initiative_id is required without a session Initiative association.'
      this.assertInitiative?.(key)
    }

    if (action === 'add') {
      await this.memory.addConvention(scope, key, text)
      return `Added [${scope}] convention: ${text}`
    }
    if (action === 'remove') {
      await this.memory.removeConvention(scope, key, text)
      return `Removed [${scope}] conventions matching: ${text}`
    }
    return `Error: unknown action "${action}"`
  }
}
