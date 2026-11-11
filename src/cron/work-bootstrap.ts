import { z } from 'zod'
import type { Tool } from '../tools/tool.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { WorkDispatcher } from './work-dispatch.ts'

const input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('register'), nodeId: z.string().min(1).max(512), path: z.string().min(1).max(4096) }).strict(),
  z.object({ action: z.literal('prepare'), folderId: z.string().min(1).max(512), branch: z.string().min(1).max(512).regex(/^refs\/(heads|remotes)\/[^\s\x00-\x1f]+$/) }).strict(),
])

/** No owner impersonation or arbitrary exec: registration uses the existing device picker. */
export class WorkBootstrapTool implements Tool {
  readonly name = 'work_bootstrap'
  readonly description = 'Current automatic bootstrap assignee only. register admits an existing, actually user-authorized repository directory on the explicit inventory nodeId; no cloning, permission grant or Main fallback. prepare takes the registered folderId and an explicit existing refs/heads/... or refs/remotes/... branch (not HEAD), validates the owning device and creates/reuses an isolated worktree. Then call workspace_use alone with its returned folderId before implementation. Retry the same source after interruption; artifacts and responsibility are retained. Direct calls only.'
  readonly parameters = { type: 'object' as const, additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['register', 'prepare'] }, nodeId: { type: 'string' }, path: { type: 'string' }, folderId: { type: 'string' }, branch: { type: 'string' },
  } }
  constructor(private readonly projectId: string, private readonly dispatcher: WorkDispatcher,
    private readonly register: (nodeId: string, path: string, signal: AbortSignal) => Promise<unknown>) {}

  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    context.signal.throwIfAborted()
    if (context.projectId !== this.projectId || context.scriptInvocation || context.remoteWorkdir || context.recoveringToolCall
      || !['invoke_tool', this.name].includes(context.toolCallName ?? '')) throw new Error('Work bootstrap requires a direct, current Project bootstrap call; no remote or replay context.')
    this.dispatcher.assertBootstrap(context.sessionId)
    const request = input.parse(args)
    if (request.action === 'prepare') return JSON.stringify(await this.dispatcher.prepareBootstrap(context.sessionId, request.folderId, request.branch, context.signal))
    const receipt = await this.register(request.nodeId, request.path, context.signal)
    context.signal.throwIfAborted()
    this.dispatcher.assertBootstrap(context.sessionId)
    return JSON.stringify(receipt)
  }
}
