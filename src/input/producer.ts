import { z } from 'zod'
import type { InputSource, InputRouter } from './router.ts'

const producedInput = z.object({
  id: z.string().min(1).max(512), kind: z.string().min(1).max(128), topic: z.string().min(1).max(512),
  correlationId: z.string().min(1).max(512).optional(), deduplicationKey: z.string().min(1).max(512).optional(),
  payload: z.unknown(),
}).strict()

/** Host-only binding for a future controlled producer, NOT a tool, public endpoint,
 * scheduler or permission grant. The host supplies identity, exact routes and a
 * live authorization check; producer data cannot supply source/Project/target or
 * convert a program signal into an authenticated human request. No reply authority
 * or explicit Session target is exposed here. Nothing installs this in cron.
 */
export function bindInputProducer<R>(router: InputRouter<unknown, R>, grant: {
  projectId: string
  source: InputSource
  routes: readonly { kind: string; topic: string }[]
  authorize: () => void | Promise<void>
}): (input: unknown) => Promise<R | undefined> {
  if (grant.projectId !== router.projectId) throw new Error('Input producer Project mismatch')
  const projectId = grant.projectId, source = Object.freeze({ ...grant.source }), routes = grant.routes.map(route => ({ ...route })), authorize = grant.authorize
  return async raw => {
    const input = producedInput.parse(raw)
    if (!routes.some(route => route.kind === input.kind && route.topic === input.topic)) throw new Error('Input producer route not granted')
    await authorize()
    return router.route({ ...input, payload: input.payload, projectId, source })
  }
}
