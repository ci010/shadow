import type { ExecutionContext } from '../tools/context.ts'

/** Host-recorded Web execution ownership is shared by BOT reads and tools.
 * The callback must resolve live same-Project structural lineage, not model bits.
 * File/device routing remains a separate authorization boundary.
 */
export function assertBotManagementAccess(projectId: string, context: ExecutionContext, assertSession: (id: string) => void): void {
  context.signal.throwIfAborted()
  if (context.projectId !== projectId || context.isGroup ||
    !['web', 'virtual'].includes(context.channel) || context.channelAddress ||
    context.memoryAccess || context.scriptInvocation || context.remoteWorkdir) {
    throw new Error('Bot management requires an owning Project Web execution.')
  }
  assertSession(context.sessionId)
}
