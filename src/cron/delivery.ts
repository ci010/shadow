/** Renderer-safe delivery semantics. Source timing and host execution strategy are orthogonal.
 * This is a projection/validation contract, never authorization to execute a job. */
export type ScheduleDelivery =
  | { kind: 'session'; sessionId: string; context: 'reuse' }
  | { kind: 'automation'; jobId: string; context: 'fresh-per-run' }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim()

/** Legacy action labels are not evidence of delivery; the admitted job is. */
export function scheduleDelivery(job: unknown): ScheduleDelivery | undefined {
  if (!record(job)) return undefined
  if (text(job.id) && job.session === 'fresh' && job.target === undefined) return { kind: 'automation', jobId: job.id, context: 'fresh-per-run' }
  if ((job.session === undefined || job.session === 'existing') && record(job.target) && text(job.target.sessionId))
    return { kind: 'session', sessionId: job.target.sessionId, context: 'reuse' }
  return undefined
}
export function validScheduleDelivery(value: unknown, job: unknown): value is ScheduleDelivery {
  const expected = scheduleDelivery(job)
  return !!expected && record(value) && Object.keys(value).length === 3 &&
    Object.entries(expected).every(([key, field]) => value[key] === field)
}
/** Old snapshots omit delivery. Conflicting explicit metadata fails closed. */
export function scheduleNodeDelivery(node: unknown): ScheduleDelivery | undefined {
  if (!record(node) || node.kind !== 'schedule-action') return undefined
  if (node.delivery !== undefined && !validScheduleDelivery(node.delivery, node.job)) return undefined
  return scheduleDelivery(node.job)
}
