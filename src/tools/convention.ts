import type { Tool, ToolParameters } from './tool.ts'
import type { ExecutionContext } from '../agent/agent.ts'
import type { MemoryStore } from '../agent/memory.ts'

type Scope = 'session' | 'project' | 'agent'

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
    'them when no longer in effect. scope: session (this conversation), project ' +
    '(shared across a project), or agent (about the agent itself).'
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
        enum: ['session', 'project', 'agent'],
        description: 'The scope the convention applies to.',
      },
      text: {
        type: 'string',
        description:
          'The convention text. For remove, a case-insensitive substring match.',
      },
      project: {
        type: 'string',
        description: 'Project name — required when scope is "project".',
      },
    },
    required: ['action', 'scope', 'text'],
  }

  constructor(private memory: MemoryStore) {}

  async execute(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<string> {
    const action = String(args.action)
    const scope = String(args.scope) as Scope
    const text = String(args.text ?? '').trim()
    if (!text) return 'Error: text is required'

    let key: string | undefined
    if (scope === 'session') {
      key = context.sessionId
    } else if (scope === 'project') {
      key = args.project != null ? String(args.project) : undefined
      if (!key) return 'Error: project name is required for scope "project"'
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
