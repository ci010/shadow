import { CronAddTool } from '../tools/cron.ts'
import type { CronService } from '../cron/service.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { WorkflowRuntime } from './runtime.ts'
import type { WorkflowAuthorAdapters } from './management.ts'

/** Reuses the exact cron authoring validation, particularly SessionManager target permissions. */
export function scheduleAuthoring(workflows: WorkflowRuntime, cron: CronService, sessions: SessionManager, resolveAgent: (name: string) => boolean): WorkflowAuthorAdapters['schedule'] {
  const author = new CronAddTool(cron, sessions, resolveAgent)
  // Hold optimistic revision validation through both durable source save and definition publication.
  let tail: Promise<unknown> = Promise.resolve()
  return (action, input, context) => {
    const operation = tail.then(async () => {
      context.signal.throwIfAborted()
      if (context.inputSource !== 'user' || context.projectId !== workflows.projectId) throw new Error('Schedule management requires direct user input in this Project')
      workflows.authorize(context.sessionId)
      const { id, expectedRevision, ...configuration } = input
      if (action !== 'schedule-create') {
        if (typeof id !== 'string' || !Number.isInteger(expectedRevision)) throw new Error('Schedule id and expectedRevision required')
        const definition = workflows.snapshot(context.sessionId).definitions.find(d => d.id === `schedule:${id}`)
        if (definition?.owner !== context.sessionId || definition.revision !== expectedRevision) throw new Error('Schedule ownership or revision conflict')
        if (action === 'schedule-remove') {
          if (Object.keys(configuration).length) throw new Error('Remove accepts only id and expectedRevision')
          if (!cron.removeJob(id)) throw new Error('Schedule cannot be removed')
          await cron.flush(); workflows.control(context.sessionId, definition.id, 'pause')
          return { removed: id }
        }
      } else if (id !== undefined || expectedRevision !== undefined) throw new Error('Create generates a fresh schedule identity')
      const allowed = Object.keys(author.parameters.properties ?? {})
      if (Object.keys(configuration).some(key => !allowed.includes(key))) throw new Error('Unknown schedule field')
      const receipt = await author.save(configuration, context, action === 'schedule-update' ? id as string : undefined)
      if (receipt.startsWith('Error:')) throw new Error(receipt)
      return { receipt, definitions: workflows.snapshot(context.sessionId).definitions.filter(d => d.source.kind === 'schedule' && d.owner === context.sessionId) }
    })
    tail = operation.then(() => undefined, () => undefined)
    return operation
  }
}
