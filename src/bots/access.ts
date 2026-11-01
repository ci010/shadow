import type { ExecutionContext } from '../tools/context.ts'

/** Bot control-plane reads have the same boundary as connection management.
 * A generic read/search grant (or an inherited admin bit) is not sufficient.
 * assertSession must check the live, runtime-owned durable/root Web session.
 */
export function assertBotManagementAccess(projectId: string, context: ExecutionContext, assertSession: (id: string) => void): void {
  context.signal.throwIfAborted()
  if (context.projectId !== projectId || context.admin !== true || context.isGroup ||
    !context.sessionId.startsWith('web:') || !['web', 'virtual'].includes(context.channel) ||
    context.channelAddress || context.memoryAccess || context.scriptInvocation || context.remoteWorkdir ||
    context.tools.executionMode !== 'session') {
    throw new Error('Bot management requires the owning Project authenticated durable Web administrator chat.')
  }
  assertSession(context.sessionId)
}
