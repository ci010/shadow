import { z } from 'zod'
import { ToolNoEffectError, type Tool, type ToolParameters } from './tool.ts'
import type { ExecutionContext } from './context.ts'
import { ActionCreateSchema, ActionPatchSchema, type ProjectActions } from '../projects/actions.ts'

const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('scripts'), folderId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('create'), definition: ActionCreateSchema }).strict(),
  z.object({ action: z.literal('patch'), id: z.string().uuid(), patch: ActionPatchSchema }).strict(),
  z.object({ action: z.literal('delete'), id: z.string().uuid() }).strict(),
])

/** Importable management capability, not a universal base tool or execution bypass. */
export class ProjectActionTool implements Tool {
  readonly name = 'project_action'
  readonly description = 'Manage reusable user actions in this Project: list, discover local npm scripts, create, patch or delete named shell commands. Requires an owning local durable Web session. Definitions use registered folderId, name, command and pinned. scripts returns runnable npm commands with lifecycle hooks; unsafe script names are omitted. Saving does not run commands or grant execution permission. No run operation: user execution is owner-controlled in the UI; existing exec authorization remains unchanged.'
  readonly readonly = (args: Record<string, unknown>) => ['list', 'scripts'].includes(String(args.action))
  readonly parameters: ToolParameters = {
    type: 'object', properties: {
      action: { type: 'string', enum: ['list', 'scripts', 'create', 'patch', 'delete'] },
      folderId: { type: 'string', description: 'scripts: registered local folder UUID.' },
      id: { type: 'string', description: 'patch/delete: existing action UUID.' },
      definition: { type: 'object', description: 'create: {name,command,folderId,pinned?}. Command is literal shell code, not a conversation prompt.' },
      patch: { type: 'object', description: 'patch: nonempty subset {name?,command?,folderId?,pinned?}.' },
    }, required: ['action'], additionalProperties: false,
  }
  constructor(private service: ProjectActions, private projectId: string, private canAuthor: (id: string) => boolean) {}
  async execute(args: Record<string, unknown>, context: ExecutionContext) {
    if (context.projectId !== this.projectId || context.remoteWorkdir || context.tools.executionMode === 'call' ||
      context.tools.dynamicOwner !== context.tools || !this.canAuthor(context.sessionId)) {
      throw new ToolNoEffectError('Project actions require an owning local durable Web session in this Project.')
    }
    context.signal.throwIfAborted()
    const parsed = inputSchema.safeParse(args)
    if (!parsed.success) throw new ToolNoEffectError(`Invalid project action arguments: ${parsed.error.message}`)
    const input = parsed.data
    if (input.action === 'list') return JSON.stringify({ actions: this.service.list() })
    if (input.action === 'scripts') return JSON.stringify(await this.service.scripts(input.folderId))
    if (input.action === 'create') return JSON.stringify({ action: await this.service.create(input.definition) })
    if (input.action === 'patch') return JSON.stringify({ action: await this.service.patch(input.id, input.patch) })
    await this.service.delete(input.id)
    return JSON.stringify({ deletedActionId: input.id })
  }
}
