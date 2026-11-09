import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { CronJob, CronService } from '../cron/service.ts'
import type { DeliverInput } from '../sessions/input.ts'
import { BotWakeSchema, type BotHostScope } from './host-contract.ts'

const request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('inspect') }).strict(),
  z.object({ action: z.literal('stop') }).strict(),
  z.object({ action: z.literal('set'), intervalMinutes: z.number().int().min(1).max(10080) }).strict(),
])
export const botWakeJobId = (scope: BotHostScope) => 'bot-wake:' + createHash('sha256').update(JSON.stringify([scope.projectId, scope.botId, scope.bindingKey, scope.sessionId])).digest('hex')
/** Uses the existing durable CronService inventory and Session admission queue.
 * Ticks carry no source cursor. Source progress is explicitly acked through the
 * existing watermark SDK only after successful consumption, never on admission.
 */
export class BotWakes {
  constructor(private cron: CronService, private deliver: DeliverInput,
    private authorize: (scope: BotHostScope) => void) {}
  async execute(scope: BotHostScope, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted(); this.authorize(scope)
    const args = request.parse(input), id = botWakeJobId(scope)
    const old = this.cron.listJobs().find(job => job.id === id)
    if (args.action === 'inspect') return { enabled: !!old && old.enabled !== false && old.botWake?.revision === scope.revision, intervalMinutes: old?.botWake?.intervalMinutes }
    if (args.action === 'stop') { this.cron.removeJob(id); await this.cron.flush(); return { enabled: false } }
    const wake = BotWakeSchema.parse({ ...scope, intervalMinutes: args.intervalMinutes })
    if (old && JSON.stringify(old.botWake) === JSON.stringify(wake) && old.enabled !== false) { await this.cron.flush(); return { enabled: true, intervalMinutes: args.intervalMinutes } }
    if (!old && this.cron.listJobs().filter(job => job.botWake?.botId === scope.botId).length >= 1000) throw new Error('BOT wake quota exceeded.')
    // Both changes are synchronous before flush; cron persistence is serialized.
    if (old) this.cron.removeJob(id)
    this.cron.addJob({ name: `BOT ${scope.botId} wake`, session: 'existing', schedule: `every ${args.intervalMinutes}m`, target: { sessionId: scope.sessionId }, botWake: wake }, id)
    await this.cron.flush()
    signal.throwIfAborted(); this.authorize(scope)
    return { enabled: true, intervalMinutes: args.intervalMinutes }
  }
  async dispatch(job: CronJob, signal: AbortSignal, now = Date.now()): Promise<void> {
    signal.throwIfAborted()
    const wake = BotWakeSchema.parse(job.botWake)
    if (job.id !== botWakeJobId(wake) || job.target?.sessionId !== wake.sessionId) throw new Error('Invalid BOT wake target.')
    const current = this.cron.listJobs().find(value => value.id === job.id)
    if (!current || current.enabled === false || JSON.stringify(current.botWake) !== JSON.stringify(wake)) return
    const { intervalMinutes: _interval, ...scope } = wake
    this.authorize(scope)
    // Stable per schedule slot: retried tick admission is idempotent in the existing Session inbox.
    const id = `${job.id}:${wake.revision}:${wake.intervalMinutes}:${Math.floor(now / (wake.intervalMinutes * 60_000))}`
    await this.deliver(wake.sessionId, { kind: 'message', id, timestamp: new Date(now).toISOString(), policy: 'queue',
      source: { kind: 'event', eventId: id, type: 'bot-wake', source: 'bot-wake', isGroup: true },
      replyTo: { channel: wake.address.platform, chatId: wake.address.conversationId, channelAddress: wake.address },
      content: 'Scheduled BOT wake. Use approved tools backed by ctx.messages to read incremental actually-received events from this original conversation, or ctx.watermark for other authorized feeds. Resume pending batches before preparing new ranges. Ack only after successful processing. This turn is host-enforced silent: assistant text, tool chatter and failures are not sent to the conversation. Only an explicit approved ctx.send.call inside a tool may send to the original conversation. No unassigned Work is automatically accepted.' })
  }
}
