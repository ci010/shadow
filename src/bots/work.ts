import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { InitiativeStore } from '../initiatives/store.ts'
import type { BotHostScope } from './host-contract.ts'
import { WorkConflict, workDefinitionSchema, type WorkRecord } from '../initiatives/work-contract.ts'

const identity = z.string().min(1).max(512)
const scopeSchema = z.object({
  projectId: identity, botId: z.string().min(1).max(128), bindingKey: z.string().min(1).max(2048),
  revision: identity, sessionId: identity, sourceInputId: identity,
}).strict()
/** Supplied only by the host from the live deployment and selected binding, never guest arguments. */
export type BotWorkScope = z.infer<typeof scopeSchema>
/** A stable binding ID can be retargeted to a different audience. Intake/query
 * authority includes the actual original connection/conversation, not just that
 * ID. Physical handoffs and deployment updates keep the same source identity. */
export function botWorkScope(scope: BotHostScope, sourceInputId: string): BotWorkScope {
  const bindingKey = createHash('sha256').update(JSON.stringify([scope.bindingKey, scope.address.projectId,
    scope.address.platform, scope.address.botInstanceId, scope.address.conversationId])).digest('hex')
  return { projectId: scope.projectId, botId: scope.botId, bindingKey, revision: scope.revision, sessionId: scope.sessionId, sourceInputId }
}
const retryKey = z.string().trim().min(1).max(200)
// External content is data, not evidence of human authorization. In particular,
// the evidence field of the ordinary Work API is not exposed here.
const definition = workDefinitionSchema.omit({ evidence: true })
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), idempotencyKey: retryKey,
    title: z.string().trim().min(1).max(160), definition }).strict(),
  z.object({ action: z.literal('query'), key: z.string().max(600).optional(),
    offset: z.number().int().min(0).max(1000).default(0), limit: z.number().int().min(1).max(50).default(20) }).strict(),
  z.object({ action: z.literal('append'), key: z.string().min(1).max(600),
    idempotencyKey: retryKey, content: z.string().trim().min(1).max(4000) }).strict(),
])
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value)
}
const fingerprint = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')

/** Narrow external intake into the existing Project Work store, not a second inbox.
 * This bridge grants no generic WorkAlignment authority. Creation has no manager,
 * executor, focus link, initial message or automatic pickup. Host must revalidate
 * deployment/binding authorization before each call. One Project runtime owns the
 * store; synchronous read/modify/save plus store sequence CAS prevents lost edits.
 */
export class BotWork {
  private readonly limits: { works: number; supplements: number }
  constructor(private readonly store: InitiativeStore, private readonly projectId: string,
    limits: { works?: number; supplements?: number } = {}) {
    identity.parse(projectId)
    this.limits = z.object({ works: z.number().int().min(1).max(1000).default(1000),
      supplements: z.number().int().min(1).max(100).default(100) }).strict().parse(limits)
  }

  execute(rawScope: BotWorkScope, rawInput: Record<string, unknown>): unknown {
    const scope = scopeSchema.parse(rawScope)
    if (scope.projectId !== this.projectId) throw new Error('Bot Work belongs to another Project.')
    // Bound serialized guest input as well as individual strings/lists.
    if (Buffer.byteLength(JSON.stringify(rawInput)) > 64_000) throw new Error('Bot Work input exceeds size limit.')
    const input = requestSchema.parse(rawInput)
    const owns = (record: WorkRecord) => record.botSource?.projectId === scope.projectId &&
      record.botSource.botId === scope.botId && record.botSource.bindingKey === scope.bindingKey
    const records = this.store.workRecords().filter(owns)
    const actor = `bot:${fingerprint([scope.projectId, scope.botId, scope.bindingKey])}`
    if (input.action === 'query') {
      const selected = input.key ? records.filter(record => record.key === input.key) : records
      // Return only source-submitted content and coarse progress. Local owner
      // notes, current definitions, assignments, sessions and tool evidence can
      // contain private context and are intentionally not projected to a group.
      const items = []
      let bytes = 0
      for (const record of selected.slice(input.offset, input.offset + input.limit)) {
        const item = {
          key: record.key, title: record.botSource!.title, definition: record.botSource!.definition,
          status: record.workflow?.status ?? 'pending',
          // This is a bounded orientation view, not a bulk history export.
          supplementCount: record.botSource!.supplements.length,
          supplements: record.botSource!.supplements.slice(-5).map(({ id, content, at }) => ({ id, content, at })),
        }
        const size = Buffer.byteLength(JSON.stringify(item))
        if (bytes + size > 256_000) break
        bytes += size; items.push(item)
      }
      const next = input.offset + items.length
      return { items, total: selected.length, ...(next < selected.length ? { nextOffset: next } : {}) }
    }
    const hash = fingerprint(input)
    if (input.action === 'create') {
      const prior = records.find(record => record.botSource!.idempotencyKey === input.idempotencyKey)
      if (prior) {
        if (prior.botSource!.fingerprint !== hash) throw new WorkConflict('Bot Work idempotency key conflicts with an earlier request.')
        return { status: 'created', key: prior.key }
      }
      if (records.length >= this.limits.works) throw new WorkConflict('Bot Work source quota exceeded.')
      const id = randomUUID(), at = new Date().toISOString()
      const record: WorkRecord = {
        key: `work:${id}`, subject: { kind: 'work', id }, revision: 1, sequence: 1,
        definition: { ...input.definition, evidence: [] }, origin: 'agent_interpretation',
        changedBy: actor, changedAt: at, change: 'understanding', paused: false,
        reason: 'Untrusted external BOT intake; not human authorization or an assignment.',
        creationRequest: { creator: actor, key: input.idempotencyKey, fingerprint: hash },
        workflow: { title: input.title, manager: null, assignee: null, assignmentRevision: 1,
          status: 'pending', dependencies: [] },
        botSource: { ...scope, idempotencyKey: input.idempotencyKey, fingerprint: hash,
          title: input.title, definition: { ...input.definition, evidence: [] }, supplements: [] },
      }
      this.store.saveWork(record, 0, actor, 'bot_intake', { source: scope, untrusted: true })
      return { status: 'created', key: record.key }
    }
    const record = records.find(record => record.key === input.key)
    if (!record) throw new Error('Bot Work not found in this source scope.')
    const source = record.botSource!
    const prior = source.supplements.find(note => note.idempotencyKey === input.idempotencyKey)
    if (prior) {
      if (prior.fingerprint !== hash) throw new WorkConflict('Bot Work append idempotency key conflicts with an earlier request.')
      return { status: 'appended', key: record.key, id: prior.id }
    }
    if (source.supplements.length >= this.limits.supplements) throw new WorkConflict('Bot Work supplement quota exceeded.')
    const note = { id: randomUUID(), idempotencyKey: input.idempotencyKey, fingerprint: hash,
      content: input.content, revision: scope.revision, sessionId: scope.sessionId,
      sourceInputId: scope.sourceInputId, at: new Date().toISOString() }
    // Supplements are not changes to the goal, assignment, authorization, status
    // or human notes, including after this Work has been assigned elsewhere.
    this.store.saveWork({ ...record, sequence: record.sequence + 1,
      botSource: { ...source, supplements: [...source.supplements, note] } }, record.sequence,
    actor, 'bot_supplement', { source: scope, supplement: note, untrusted: true })
    return { status: 'appended', key: record.key, id: note.id }
  }
}
